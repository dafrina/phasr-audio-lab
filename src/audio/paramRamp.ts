/**
 * Instrument-parameter ramps as the sampler and drum rack keep them: those
 * instruments read an automated value when a note starts (a hit's tune, gain,
 * decay …), from the same 'param' segments the worklet instruments ramp through.
 */
import { lerpDomain } from '../project/curves';

/** One instrument-parameter ramp as the sampler and drum rack keep it (context seconds). */
export interface ParamRamp {
  t0: number;
  v0: number;
  t1: number;
  v1: number;
  /** exponential (exp-curve parameters: straight on the lane's log scale, as the worklets ramp them) */
  exp?: boolean;
}

/**
 * The value at time t of a parameter driven by ramps sorted by start time
 * (`held` before the first): the sampler and the drum rack read their
 * automated values with this when a note starts.
 */
export function rampValueAt(ramps: readonly ParamRamp[] | undefined, t: number, held: number | null): number | null {
  let v = held;
  for (const s of ramps ?? []) {
    if (s.t0 > t) break;
    v = t >= s.t1 || s.t1 <= s.t0 ? s.v1 : lerpDomain(s.v0, s.v1, (t - s.t0) / (s.t1 - s.t0), !!s.exp);
  }
  return v;
}
