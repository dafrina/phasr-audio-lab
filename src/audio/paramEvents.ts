/**
 * Put a lane's planned automation events on an AudioParam — the one place the
 * live transport and the export do it, so they ramp identically: a 'set' jumps,
 * a 'ramp' goes from the previous event to its value, exponentially for
 * exp-curve parameters (frequency, times: straight on the lane's log scale) and
 * linearly otherwise. Shaped segments arrive already split into short ramps
 * (project/automation `playbackPoints`).
 */
import type { AutomationEvent } from './scheduling';
import type { ParamTarget } from './effects/units';

export function applyParamEvents(t: ParamTarget, events: readonly AutomationEvent[]): void {
  for (const e of events) {
    const v = t.map(e.value);
    if (e.kind === 'set') t.param.setValueAtTime(v, e.time);
    else if (t.exp && v > 0) t.param.exponentialRampToValueAtTime(v, e.time);
    else t.param.linearRampToValueAtTime(v, e.time);
  }
}
