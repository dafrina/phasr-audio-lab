/** Copy / cut / paste / duplicate of automation points (project/automationClipboard). */
import { describe, expect, it } from 'vitest';
import { copyPoints, duplicatePoints, mapValue, pastePoints, removePoints } from '../src/project/automationClipboard';
import type { ShapeDomain } from '../src/project/curves';
import type { AutomationLane, AutomationPoint } from '../src/project/types';

const DB: ShapeDomain = { curve: 'linear', min: -60, max: 6 };
const UNIT: ShapeDomain = { curve: 'linear', min: 0, max: 1 };
const HZ: ShapeDomain = { curve: 'exp', min: 20, max: 20000 };

const lane = (points: AutomationPoint[]): AutomationLane => ({ id: 'L', target: { kind: 'track', param: 'volumeDb' }, enabled: true, points });
const src = () =>
  lane([
    { id: 'a', tick: 960, value: -30, shape: { type: 'curve', amount: 0.5 } },
    { id: 'b', tick: 1920, value: 0, shape: { type: 's', steepness: 0.4, bend: 0.7 } },
    { id: 'c', tick: 2880, value: -12, shape: { type: 'hold' } },
    { id: 'd', tick: 3840, value: -6 },
  ]);
const view = (l: AutomationLane) => l.points.map((p) => [p.tick, p.value, p.shape?.type ?? '-']);

describe('copy', () => {
  it('keeps timing relative to the first point, the values, and the shapes between the copied points', () => {
    const c = copyPoints(src(), ['c', 'a', 'b'], DB)!;
    expect(c.span).toBe(1920);
    expect(c.points).toEqual([
      { dt: 0, value: -30, shape: { type: 'curve', amount: 0.5 } },
      { dt: 960, value: 0, shape: { type: 's', steepness: 0.4, bend: 0.7 } },
      // the last copied point's segment led to a point that wasn't copied: it pastes linear
      { dt: 1920, value: -12 },
    ]);
    expect(c.domain).toEqual(DB);
    expect(copyPoints(src(), ['nope'], DB)).toBeNull();
  });
});

describe('value mapping', () => {
  it('the same range: as is (clamped); another range: by normalised position, clamped', () => {
    expect(mapValue(-17.5, DB, DB)).toBe(-17.5);
    expect(mapValue(9, DB, DB)).toBe(6);
    expect(mapValue(-27, DB, UNIT)).toBeCloseTo(0.5, 12);
    expect(mapValue(0.25, UNIT, DB)).toBeCloseTo(-43.5, 12);
    // exp-curve parameters by their log position, as the lane draws them
    expect(mapValue(Math.sqrt(20 * 20000), HZ, UNIT)).toBeCloseTo(0.5, 12);
    expect(mapValue(0.5, UNIT, HZ)).toBeCloseTo(Math.sqrt(20 * 20000), 9);
    expect(mapValue(2, UNIT, HZ)).toBe(20000);
    expect(mapValue(-1, UNIT, HZ)).toBe(20);
    expect(mapValue(440, HZ, { curve: 'exp', min: 20, max: 20000 })).toBe(440);
  });
});

describe('paste', () => {
  it('at a new position: relative timing, values and shapes kept; new ids; the lane stays sorted', () => {
    const c = copyPoints(src(), ['a', 'b', 'c'], DB)!;
    const { lane: l, ids } = pastePoints(src(), c, 7680, DB);
    expect(view(l)).toEqual([
      [960, -30, 'curve'], [1920, 0, 's'], [2880, -12, 'hold'], [3840, -6, '-'],
      [7680, -30, 'curve'], [8640, 0, 's'], [9600, -12, '-'],
    ]);
    expect(ids).toHaveLength(3);
    expect(new Set(l.points.map((p) => p.id)).size).toBe(l.points.length);
    expect(l.points.find((p) => p.tick === 8640)!.shape).toEqual({ type: 's', steepness: 0.4, bend: 0.7 });
  });

  it('into a lane with another range: values mapped by normalised position', () => {
    const c = copyPoints(src(), ['a', 'b'], DB)!;
    const { lane: l } = pastePoints(lane([]), c, 0, UNIT);
    expect(l.points.map((p) => p.value)).toEqual([mapValue(-30, DB, UNIT), mapValue(0, DB, UNIT)]);
    expect(l.points[0]!.value).toBeCloseTo(30 / 66, 12);
  });

  it('over existing points: the points strictly inside the pasted span are replaced (no interleaving), the rest untouched', () => {
    const c = copyPoints(src(), ['a', 'b', 'c'], DB)!; // span 1920
    const dest = lane([
      { id: 'x', tick: 0, value: -1 },
      { id: 'y', tick: 1500, value: -2 },
      { id: 'z', tick: 2000, value: -3 },
      { id: 'w', tick: 5000, value: -4 },
    ]);
    const { lane: l } = pastePoints(dest, c, 1000, DB); // 1000 … 2920
    expect(view(l)).toEqual([[0, -1, '-'], [1000, -30, 'curve'], [1960, 0, 's'], [2920, -12, '-'], [5000, -4, '-']]);
  });

  it('a point on an edge of the span stays and forms a step with the pasted one (existing → pasted at the start, pasted → existing at the end) — or is replaced when the copy repeats its value', () => {
    const c = copyPoints(src(), ['a', 'b', 'c'], DB)!; // −30 … −12, span 1920
    const edges = lane([{ id: 's', tick: 1000, value: -50 }, { id: 'e', tick: 2920, value: 3 }]);
    expect(view(pastePoints(edges, c, 1000, DB).lane)).toEqual([[1000, -50, '-'], [1000, -30, 'curve'], [1960, 0, 's'], [2920, -12, '-'], [2920, 3, '-']]);
    const same = lane([{ id: 's', tick: 1000, value: -30 }, { id: 'e', tick: 2920, value: -12 }]);
    const r = pastePoints(same, c, 1000, DB);
    expect(view(r.lane)).toEqual([[1000, -30, 'curve'], [1960, 0, 's'], [2920, -12, '-']]);
    expect(r.lane.points.every((p) => r.ids.includes(p.id))).toBe(true);
  });

  it('a single pasted point replaces whatever is on its tick', () => {
    const c = copyPoints(src(), ['b'], DB)!;
    expect(c.span).toBe(0);
    const dest = lane([{ id: 'p', tick: 960, value: -5 }, { id: 'q', tick: 960, value: -7 }, { id: 'r', tick: 961, value: -8 }]);
    expect(view(pastePoints(dest, c, 960, DB).lane)).toEqual([[960, 0, '-'], [961, -8, '-']]);
  });
});

describe('duplicate and cut', () => {
  it('duplicate starts the copy on the last selected point: a ramp repeats as a clean sawtooth', () => {
    const ramp = lane([{ id: 'lo', tick: 0, value: -40, shape: { type: 'curve', amount: 0.6 } }, { id: 'hi', tick: 3840, value: 0 }]);
    const r = duplicatePoints(ramp, ['lo', 'hi'], DB, 960)!;
    expect(view(r.lane)).toEqual([[0, -40, 'curve'], [3840, 0, '-'], [3840, -40, 'curve'], [7680, 0, '-']]);
    // a repeating pattern (same value at both ends) joins without a duplicate point
    const loop = lane([{ id: 'a', tick: 0, value: -10 }, { id: 'b', tick: 960, value: 0 }, { id: 'c', tick: 1920, value: -10 }]);
    expect(view(duplicatePoints(loop, ['a', 'b', 'c'], DB, 960)!.lane)).toEqual([[0, -10, '-'], [960, 0, '-'], [1920, -10, '-'], [2880, 0, '-'], [3840, -10, '-']]);
    // a single point: one beat later (replacing the point on that tick)
    expect(view(duplicatePoints(loop, ['b'], DB, 960)!.lane)).toEqual([[0, -10, '-'], [960, 0, '-'], [1920, 0, '-']]);
    expect(duplicatePoints(loop, ['nope'], DB, 960)).toBeNull();
  });

  it('cut removes the copied points', () => {
    expect(view(removePoints(src(), ['a', 'c']))).toEqual([[1920, 0, 's'], [3840, -6, '-']]);
  });
});
