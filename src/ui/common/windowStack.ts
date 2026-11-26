/**
 * Stacking order of the floating instrument / tool windows: the one clicked
 * last is in front. Each open window registers itself; z-indexes stay in a
 * small band (40..48) under menus and popovers.
 */
import { useCallback, useEffect } from 'react';
import { create } from 'zustand';

const BASE_Z = 40;
const MAX_RANK = 8;

const useWindowStack = create<{ order: string[] }>(() => ({ order: [] }));

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
