/**
 * Copy / cut / paste / duplicate of automation points (pure lane operations;
 * the app keeps one point clipboard — state/automationActions).
 *
 * A copy keeps the points' timing relative to the first one, their values and
 * the shapes of the segments between them (the last copied point's segment led
 * to a point that wasn't copied, so it pastes linear).
 *
 * Values: into a lane on a parameter with the same range they paste as they are;
 * into a different range they map by normalised position (log for exp-curve
 * parameters, as the lane draws them), clamped to the range.
 *
 * Paste over existing points replaces the points strictly inside the pasted span,
 * so the two passages never interleave; everything outside it is untouched. A
 * point exactly on either edge of the span is kept and forms a step with the
 * pasted point on the same tick (existing → pasted at the start, pasted →
 * existing at the end), unless both have the same value, in which case the copy
 * replaces it. That's what makes duplicating a ramp repeat it as a clean
 * sawtooth instead of erasing the original's end value. A single pasted point
 * (no span) replaces whatever is on its tick.
 */
import { createId } from '../core/ids';
import { domainPos, isExpDomain, normalizeShape, type AutomationShape, type ShapeDomain } from './curves';
import type { AutomationLane, AutomationPoint } from './types';

export interface PointClipboard {
  /** the source parameter's range */
  domain: ShapeDomain;
  /** ticks after the first copied point, values, shapes (ascending) */
  points: { dt: number; value: number; shape?: AutomationShape }[];
  /** ticks from the first to the last copied point */
  span: number;
}

const sameDomain = (a: ShapeDomain, b: ShapeDomain) => a.min === b.min && a.max === b.max && isExpDomain(a) === isExpDomain(b);

/** a value from one parameter range into another (as is for the same range; by normalised position otherwise), clamped */
export function mapValue(v: number, from: ShapeDomain, to: ShapeDomain): number {
  const clamp = (x: number) => Math.min(to.max, Math.max(to.min, x));
  if (sameDomain(from, to)) return clamp(v);
  const n = Math.min(1, Math.max(0, domainPos(from, v)));
  return clamp(isExpDomain(to) ? to.min * Math.pow(to.max / to.min, n) : to.min + (to.max - to.min) * n);
}

/** Copy the given points of a lane (null when none of them is in it). */
export function copyPoints(lane: AutomationLane, ids: readonly string[], domain: ShapeDomain): PointClipboard | null {
  const want = new Set(ids);
  const sel = lane.points.filter((p) => want.has(p.id));
  if (!sel.length) return null;
  const t0 = (sel[0] as AutomationPoint).tick;
  return {
    domain: { curve: domain.curve, min: domain.min, max: domain.max },
    points: sel.map((p, i) => ({ dt: p.tick - t0, value: p.value, ...(p.shape && i < sel.length - 1 ? { shape: p.shape } : {}) })),
    span: (sel[sel.length - 1] as AutomationPoint).tick - t0,
  };
}

export function removePoints(lane: AutomationLane, ids: readonly string[]): AutomationLane {
  const drop = new Set(ids);
  return { ...lane, points: lane.points.filter((p) => !drop.has(p.id)) };
}

/** Paste a copy with its first point at `at` (rules above). Returns the lane and the new points' ids. */
export function pastePoints(lane: AutomationLane, clip: PointClipboard, at: number, domain: ShapeDomain): { lane: AutomationLane; ids: string[] } {
  const start = Math.max(0, Math.round(at));
  const end = start + clip.span;
  const pasted: AutomationPoint[] = clip.points.map((q) => {
    const shape = normalizeShape(q.shape);
    return { id: createId('ap'), tick: start + q.dt, value: mapValue(q.value, clip.domain, domain), ...(shape ? { shape } : {}) };
  });
  const first = pasted[0] as AutomationPoint;
  const last = pasted[pasted.length - 1] as AutomationPoint;
  const before: AutomationPoint[] = [];
  const after: AutomationPoint[] = [];
  for (const p of lane.points) {
    if (clip.span === 0) {
      if (p.tick < start) before.push(p);
      else if (p.tick > start) after.push(p);
      continue;
    }
    if (p.tick < start || (p.tick === start && p.value !== first.value)) before.push(p);
    else if (p.tick > end || (p.tick === end && p.value !== last.value)) after.push(p);
    // (strictly inside the span, or an edge point the copy repeats exactly: replaced)
  }
  // concatenated in tick order; equal ticks keep this order: existing → pasted at the start, pasted → existing at the end
  return { lane: { ...lane, points: [...before, ...pasted, ...after] }, ids: pasted.map((p) => p.id) };
}

/**
 * Duplicate the given points right after themselves: the copy starts on the last
 * selected point (one beat after a single point), as one paste.
 */
export function duplicatePoints(lane: AutomationLane, ids: readonly string[], domain: ShapeDomain, beatTicks: number): { lane: AutomationLane; ids: string[] } | null {
  const clip = copyPoints(lane, ids, domain);
  if (!clip) return null;
  const want = new Set(ids);
  const first = lane.points.find((p) => want.has(p.id)) as AutomationPoint;
  return pastePoints(lane, clip, first.tick + (clip.span > 0 ? clip.span : beatTicks), domain);
}
