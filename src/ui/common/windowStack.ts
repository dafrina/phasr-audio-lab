/**
 * Stacking order of the floating instrument / tool windows: the one clicked
 * last is in front. Each open window registers itself; z-indexes stay in a
 * small band (40..48) under menus and popovers. The front window also gets
 * the computer keyboard (see liveKeys.ts).
 */
import { useCallback, useEffect } from 'react';
import { create } from 'zustand';

const BASE_Z = 40;
const MAX_RANK = 8;

const useWindowStack = create<{ order: string[] }>(() => ({ order: [] }));

/** where a window is in the stack (higher = further in front), −1 if it isn't open */
export function windowRank(id: string): number {
  return useWindowStack.getState().order.indexOf(id);
}

/** whether this window is open and in front of the others */
export function isFrontWindow(id: string): boolean {
  const { order } = useWindowStack.getState();
  return order.length > 0 && order[order.length - 1] === id;
}

export function raiseWindow(id: string): void {
  const { order } = useWindowStack.getState();
  if (order[order.length - 1] === id) return;
  useWindowStack.setState({ order: [...order.filter((x) => x !== id), id] });
}

/** z-index for a window (and its decorations), and a handler that brings it to the front. Opening it raises it. */
export function useWindowZ(id: string): { z: number; raise: () => void } {
  useEffect(() => {
    raiseWindow(id);
    return () => useWindowStack.setState((s) => ({ order: s.order.filter((x) => x !== id) }));
  }, [id]);
  const rank = useWindowStack((s) => s.order.indexOf(id));
  const raise = useCallback(() => raiseWindow(id), [id]);
  return { z: BASE_Z + Math.max(0, Math.min(MAX_RANK, rank)), raise };
}
