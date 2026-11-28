/**
 * Selected automation points (one lane at a time) and where the pointer is over
 * an automation lane: the arrangement sets them, the shortcuts (copy / cut /
 * paste / duplicate / delete) read them.
 */
export interface AutoSelection {
  trackId: string;
  laneId: string;
  ids: string[];
}

let selection: AutoSelection | null = null;
/** the lane position under the pointer (automation mode), for paste */
let hover: { trackId: string; laneId: string; tick: number } | null = null;
const listeners = new Set<() => void>();

export function getAutoSelection(): AutoSelection | null {
  return selection;
}

export function setAutoSelection(s: AutoSelection | null): void {
  selection = s && s.ids.length ? s : null;
  for (const f of listeners) f();
}

export function subscribeAutoSelection(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

export function getAutoHover(): { trackId: string; laneId: string; tick: number } | null {
  return hover;
}

export function setAutoHover(h: { trackId: string; laneId: string; tick: number } | null): void {
  hover = h;
}
