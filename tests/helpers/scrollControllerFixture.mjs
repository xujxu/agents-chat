import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import * as geometry from '../../app/features/chat/chatScrollGeometry.ts';

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(callback);
    },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
    emit(name, event = {}) { for (const callback of listeners.get(name) ?? []) callback(event); },
  };
}

export async function createScrollControllerFixture({ height = 192, initial } = {}) {
  const frames = new Map();
  const timers = new Map();
  const observers = [];
  let nextId = 0;
  let top = initial?.scrollTop ?? 0;
  const container = {
    ...eventTarget(),
    clientWidth: 844, clientHeight: height, scrollHeight: 8061,
    get scrollTop() { return top; },
    set scrollTop(value) { top = geometry.clampScrollTop(value, this.scrollHeight - this.clientHeight); },
    querySelector() { return null; },
    contains() { return false; },
    scrollTo({ top: value }) { this.scrollTop = value; },
  };
  const initialPoint = container.scrollTop + height - (initial?.anchor?.bottomGap ?? 0);
  const anchors = {
    captureReadingAnchor: () => ({
      kind: 'element', messageId: 'fixture', index: 0, fraction: 0,
      bottomGap: container.clientHeight - (initialPoint - container.scrollTop),
    }),
    chatViewport: () => ({ top: 0, bottom: container.clientHeight, left: 0, right: 844 }),
    resolveReadingAnchor: () => initialPoint - container.scrollTop,
  };
  class Observer {
    constructor(callback) { this.callback = callback; this.active = false; observers.push(this); }
    observe() { this.active = true; }
    disconnect() { this.active = false; }
    deliver() { if (this.active) this.callback(); }
  }
  const context = createContext({
    window: eventTarget(), Element: class {}, Node: class {},
    ResizeObserver: Observer, MutationObserver: Observer,
    requestAnimationFrame(callback) { const id = ++nextId; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(callback) { const id = ++nextId; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  const source = await readFile(new URL('../../app/features/chat/runtime/chatScrollController.ts', import.meta.url), 'utf8');
  const module = new SourceTextModule(stripTypeScriptTypes(source), { context });
  await module.link(specifier => {
    const exports = specifier === '../chatScrollGeometry' ? geometry
      : specifier === '../chatReadingAnchor' ? anchors : null;
    if (!exports) throw new Error(`Unexpected controller import: ${specifier}`);
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  const controller = module.namespace.createChatScrollController(container, () => {}, initial);
  return {
    container, controller,
    emit: (name, event) => container.emit(name, event),
    resize(value) {
      container.clientHeight = value;
      container.scrollTop = container.scrollTop;
    },
    deliverResize: () => observers[0].deliver(),
    pendingFrames: () => frames.size,
    frame() {
      const queued = [...frames.values()];
      frames.clear();
      for (const callback of queued) callback();
    },
    cleanup() { controller.dispose(); frames.clear(); timers.clear(); },
  };
}
