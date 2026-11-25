/**
 * Snapshot-based undo history. Because project updates are immutable with
 * structural sharing, keeping previous project objects is cheap. Continuous
 * gestures (dragging a knob or a clip) pass a `coalesceKey` so a whole drag
 * becomes a single undo step.
 */
export interface History<T> {
  past: T[];
  present: T;
  future: T[];
  /** coalescing state for the most recent entry */
  lastKey: string | null;
  lastTime: number;
  labels: string[];
}

export const HISTORY_LIMIT = 200;
export const COALESCE_WINDOW_MS = 1500;

export function createHistory<T>(present: T): History<T> {
  return { past: [], present, future: [], lastKey: null, lastTime: 0, labels: [] };
}

export function pushHistory<T>(h: History<T>, next: T, label: string, coalesceKey: string | null, now: number): History<T> {
  if (next === h.present) return h;
  const coalesce = coalesceKey !== null && coalesceKey === h.lastKey && now - h.lastTime < COALESCE_WINDOW_MS;
  if (coalesce) {
    return { ...h, present: next, future: [], lastTime: now };
  }
  const past = [...h.past, h.present];
  const labels = [...h.labels, label];
  if (past.length > HISTORY_LIMIT) {
    past.shift();
    labels.shift();
  }
  return { past, present: next, future: [], lastKey: coalesceKey, lastTime: now, labels };
}

export function undoHistory<T>(h: History<T>): History<T> {
  const prev = h.past[h.past.length - 1];
  if (prev === undefined) return h;
  return {
    past: h.past.slice(0, -1),
    present: prev,
    future: [h.present, ...h.future],
    lastKey: null,
    lastTime: 0,
    labels: h.labels.slice(0, -1),
  };
}

export function redoHistory<T>(h: History<T>): History<T> {
  const next = h.future[0];
  if (next === undefined) return h;
  return {
    past: [...h.past, h.present],
    present: next,
    future: h.future.slice(1),
    lastKey: null,
    lastTime: 0,
    labels: [...h.labels, 'redo'],
  };
}

/** Replace the present without creating an undo step (for non-undoable state like arm/monitor). */
export function replacePresent<T>(h: History<T>, next: T): History<T> {
  return { ...h, present: next };
}
