export type ViewportObservation = {
  now: number;
  scale: number | null;
  width: number | null;
  clientWidth: number;
  orientation: 'portrait' | 'landscape';
  touches: number;
  editable: boolean;
};

export function validGeometry(o: ViewportObservation): o is ViewportObservation & { scale: number; width: number } {
  return o.scale !== null && Number.isFinite(o.scale) && o.scale > 0
    && o.width !== null && Number.isFinite(o.width) && o.width > 0
    && Number.isFinite(o.clientWidth) && o.clientWidth > 0;
}

export const atOriginalScale = (o: ViewportObservation) =>
  validGeometry(o) && Math.abs(o.scale - 1) <= 0.01 && Math.abs(o.width - o.clientWidth) <= 2;

export const consistentGeometry = (o: ViewportObservation) =>
  validGeometry(o) && Math.abs(o.width * o.scale - o.clientWidth) <= Math.max(2, o.scale);

export function createViewportStability() {
  let key = '';
  let since = 0;
  let count = 0;
  return {
    reset() { key = ''; count = 0; },
    sample(o: ViewportObservation) {
      if (!validGeometry(o)) {
        key = ''; count = 0;
        return false;
      }
      const next = `${o.scale}/${o.width}/${o.clientWidth}/${o.orientation}`;
      if (key !== next) { key = next; since = o.now; count = 0; }
      count++;
      return !o.touches && !o.editable && count >= 3 && o.now - since >= 300;
    },
  };
}
