/**
 * Deterministic polyphonic voice allocation.
 *
 * 1. If fewer than `polyphony` voices are sounding, use the lowest-index idle voice.
 * 2. Otherwise steal: prefer the oldest voice that is already releasing,
 *    then the oldest held voice. Ties go to the lowest index.
 *
 * "Oldest" uses a monotonically increasing start order, never wall time, so the
 * same note sequence always produces the same allocation.
 */
export interface VoiceSlot {
  active: boolean;
  released: boolean;
  order: number;
}

export interface Allocation {
  index: number;
  steal: boolean;
}

export function allocateVoice(slots: readonly VoiceSlot[], polyphony: number): Allocation {
  const limit = Math.max(1, Math.min(polyphony, slots.length));
  let activeCount = 0;
  let firstIdle = -1;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (!s) continue;
    if (s.active) activeCount++;
    else if (firstIdle < 0 && i < limit) firstIdle = i;
  }
  if (activeCount < limit) {
    if (firstIdle >= 0) return { index: firstIdle, steal: false };
    // all slots below the limit are busy but some above aren't counted; fall back to any idle slot
    for (let i = 0; i < slots.length; i++) if (!slots[i]?.active) return { index: i, steal: false };
  }
  let best = -1;
  let bestReleased = false;
  let bestOrder = Number.POSITIVE_INFINITY;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (!s || !s.active) continue;
    const better =
      best < 0 ||
      (s.released && !bestReleased) ||
      (s.released === bestReleased && s.order < bestOrder);
    if (better) {
      best = i;
      bestReleased = s.released;
      bestOrder = s.order;
    }
  }
  return { index: Math.max(0, best), steal: true };
}
