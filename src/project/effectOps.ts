/** Pure operations on a track's insert-effect chain (max 4 slots). */
import { MAX_EFFECT_SLOTS, type EffectSlot } from './types';

export function addEffectSlot(chain: EffectSlot[], slot: EffectSlot, index = chain.length): EffectSlot[] | null {
  if (chain.length >= MAX_EFFECT_SLOTS) return null;
  const next = [...chain];
  next.splice(Math.max(0, Math.min(chain.length, index)), 0, slot);
  return next;
}

export function removeEffectSlot(chain: EffectSlot[], id: string): EffectSlot[] {
  return chain.filter((s) => s.id !== id);
}

/** Move a slot by `delta` positions (clamped). */
export function moveEffectSlot(chain: EffectSlot[], id: string, delta: number): EffectSlot[] {
  const from = chain.findIndex((s) => s.id === id);
  if (from < 0) return chain;
  const to = Math.max(0, Math.min(chain.length - 1, from + delta));
  if (to === from) return chain;
  const next = [...chain];
  const [s] = next.splice(from, 1);
  if (s) next.splice(to, 0, s);
  return next;
}

export function updateEffectSlot(chain: EffectSlot[], id: string, fn: (s: EffectSlot) => EffectSlot): EffectSlot[] {
  return chain.map((s) => (s.id === id ? fn(s) : s));
}

/** Merge partial params into a slot, keeping the discriminated union intact. */
export function withParams(slot: EffectSlot, params: Partial<EffectSlot['params']>): EffectSlot {
  return { ...slot, params: { ...slot.params, ...params } } as EffectSlot;
}
