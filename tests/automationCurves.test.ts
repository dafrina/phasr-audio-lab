/**
 * Curved automation segments: the shape math, the subdivision playback uses
 * (error bounded and measured), the scheduler (live lookahead windows = the
 * export's single plan, across window and loop boundaries), editing and
 * persistence.
 */
import { describe, expect, it } from 'vitest';
import {
  CURVE_K,
  PLAYBACK_EPS,
  PLAYBACK_MAX_STEP,
  chordError,
  curveAmountForMid,
  detent,
  domainPos,
  handleX,
  isLinearShape,
  sanitizeShape,
  shapeBreaks,
  shapeFrac,
  shapeLabel,
  type AutomationShape,
} from '../src/project/curves';
import { addPoint, createLane, movePoint, playbackPoints, sanitizeLanes, segmentStarts, setShapes, valueAt } from '../src/project/automation';
import { computeSegments, inOrder, planWindow, toParamSegments, type AutomationEvent, type Cursor, type PlanContext } from '../src/audio/scheduling';
import { rampValueAt } from '../src/audio/paramRamp';
import { createProject } from '../src/project/defaults';
import { migrateProject } from '../src/project/migrations';
import type { NumericParamSpec } from '../src/synth/params';
import { PROJECT_SCHEMA_VERSION, type AutomationLane, type AutomationPoint } from '../src/project/types';

const BPM = 120; // 1920 ticks per second
const BAR = 3840;
const DB: NumericParamSpec = { label: 'Volume', min: -60, max: 6, default: 0, curve: 'linear', format: String };
const HZ: NumericParamSpec = { label: 'Cutoff', min: 20, max: 20000, default: 1000, curve: 'exp', format: String };
const UNIT: NumericParamSpec = { label: 'Mix', min: 0, max: 1, default: 0.5, curve: 'linear', format: String };

const SHAPES: AutomationShape[] = [
  ...[-1, -0.6, -0.2, 0.2, 0.6, 1].map((amount): AutomationShape => ({ type: 'curve', amount })),
  ...[-1, -0.5, 0.3, 0.7, 1].flatMap((steepness) => [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1].map((bend): AutomationShape => ({ type: 's', steepness, bend }))),
];
const grid = (n: number) => Array.from({ length: n + 1 }, (_, i) => i / n);

describe('shape math', () => {
  it('every shape starts and ends exactly on its points and never turns back', () => {
    for (const s of [...SHAPES, { type: 'hold' } as const, undefined]) {
      expect(shapeFrac(s, 0), JSON.stringify(s)).toBe(0);
      expect(shapeFrac(s, 1), JSON.stringify(s)).toBe(1);
      let prev = -Infinity;
      for (const x of grid(4000)) {
        const f = shapeFrac(s, x);
        expect(f, `${JSON.stringify(s)} at ${x}`).toBeGreaterThanOrEqual(prev - 1e-15);
        expect(f).toBeGreaterThanOrEqual(0);
        expect(f).toBeLessThanOrEqual(1);
        prev = f;
      }
    }
  });

  it('curve: + is slow then fast (below the line), − is fast then slow, 0 is exactly linear', () => {
    for (const x of grid(50).slice(1, -1)) {
      expect(shapeFrac({ type: 'curve', amount: 0.5 }, x)).toBeLessThan(x);
      expect(shapeFrac({ type: 'curve', amount: -0.5 }, x)).toBeGreaterThan(x);
      expect(shapeFrac({ type: 'curve', amount: 0 }, x)).toBe(x);
    }
    // a stronger amount bends further; at full amount the midpoint sits 7.6 % of the way
    expect(shapeFrac({ type: 'curve', amount: 1 }, 0.5)).toBeCloseTo(1 / (Math.exp(CURVE_K / 2) + 1), 12);
    expect(shapeFrac({ type: 'curve', amount: 1 }, 0.5)).toBeLessThan(shapeFrac({ type: 'curve', amount: 0.5 }, 0.5));
    // the handle maps back: the amount whose midpoint is m
    for (const a of [-0.9, -0.3, 0.05, 0.4, 1]) expect(curveAmountForMid(shapeFrac({ type: 'curve', amount: a }, 0.5))).toBeCloseTo(a, 9);
  });

  it('S-curve: steepness 0 is exactly linear at any bend; it passes through the bend on the straight line', () => {
    for (const bend of [0, 0.2, 0.5, 0.85, 1]) {
      for (const x of grid(40)) expect(shapeFrac({ type: 's', steepness: 0, bend }, x)).toBeCloseTo(x, 14);
      for (const steepness of [-1, -0.4, 0.5, 1]) expect(shapeFrac({ type: 's', steepness, bend }, bend)).toBeCloseTo(bend, 14);
    }
  });

  it('S-curve +: slow – fast – slow, steepest at the bend; at +1 ≈ a smooth step at the bend (10 %→90 % within 7 % of the segment)', () => {
    for (const bend of [0.3, 0.5, 0.7]) {
      const s: AutomationShape = { type: 's', steepness: 0.6, bend };
      for (const x of grid(50).slice(1, -1)) {
        if (x < bend - 1e-9) expect(shapeFrac(s, x)).toBeLessThan(x);
        if (x > bend + 1e-9) expect(shapeFrac(s, x)).toBeGreaterThan(x);
      }
      // steepest at the bend
      const slope = (x: number) => (shapeFrac(s, x + 1e-4) - shapeFrac(s, x - 1e-4)) / 2e-4;
      for (const x of grid(40).filter((v) => v > 0.01 && v < 0.99 && Math.abs(v - bend) > 0.02)) expect(slope(x)).toBeLessThan(slope(bend));
      // full steepness: the whole change happens around the bend
      const step: AutomationShape = { type: 's', steepness: 1, bend };
      const cross = (f: number) => grid(20000).find((x) => shapeFrac(step, x) >= f)!;
      expect(cross(0.1)).toBeGreaterThan(bend - 0.07);
      expect(cross(0.9)).toBeLessThan(bend + 0.07);
    }
    // the steepness feels even: halfway is a moderate S (10 %→90 % over more than a fifth of the segment),
    // not almost a step already (fine control near straight)
    const half: AutomationShape = { type: 's', steepness: 0.5, bend: 0.5 };
    const crossHalf = (f: number) => grid(20000).find((x) => shapeFrac(half, x) >= f)!;
    expect(crossHalf(0.9) - crossHalf(0.1)).toBeGreaterThan(0.2);
    expect(crossHalf(0.9) - crossHalf(0.1)).toBeLessThan(0.5);
    // lopsided: ease in slowly, snap open late
    const late: AutomationShape = { type: 's', steepness: 1, bend: 0.7 };
    expect(shapeFrac(late, 0.6)).toBeLessThan(0.03);
    expect(shapeFrac(late, 0.8)).toBeGreaterThan(0.99);
  });

  it('S-curve −: inverse S, fast at the ends and flat in the middle (at the bend)', () => {
    const s: AutomationShape = { type: 's', steepness: -1, bend: 0.4 };
    for (const x of grid(100).filter((v) => v > 0.15 && v < 0.6)) expect(Math.abs(shapeFrac(s, x) - 0.4)).toBeLessThan(0.01);
    // the change happens at the ends: most of the first part within 4 % of the segment, of the second within the last 2 %
    expect(shapeFrac(s, 0.04)).toBeGreaterThan(0.3);
    expect((1 - shapeFrac(s, 0.98)) / 0.02).toBeGreaterThan(10);
    const half: AutomationShape = { type: 's', steepness: -0.5, bend: 0.5 };
    expect(shapeFrac(half, 0.25)).toBeGreaterThan(0.25);
    expect(shapeFrac(half, 0.75)).toBeLessThan(0.75);
  });

  it('hold keeps the start value until the next point', () => {
    for (const x of grid(100).slice(0, -1)) expect(shapeFrac({ type: 'hold' }, x)).toBe(0);
  });

  it('the handle sits mid-segment (an S: at its bend); the detent snaps to straight', () => {
    expect(handleX(undefined)).toBe(0.5);
    expect(handleX({ type: 'curve', amount: 0.7 })).toBe(0.5);
    expect(handleX({ type: 's', steepness: 0.2, bend: 0.8 })).toBe(0.8);
    expect([detent(0.03), detent(-0.039), detent(0.05), detent(-0.3)]).toEqual([0, 0, 0.05, -0.3]);
    expect([detent(0.52, 0.5), detent(0.6, 0.5)]).toEqual([0.5, 0.6]);
    expect(isLinearShape({ type: 'curve', amount: 0 })).toBe(true);
    expect(isLinearShape({ type: 's', steepness: 0, bend: 0.3 })).toBe(true);
    expect(isLinearShape({ type: 'hold' })).toBe(false);
  });

  it('readouts', () => {
    expect(shapeLabel({ type: 'curve', amount: 0.4 })).toBe('Curve +40%');
    expect(shapeLabel({ type: 'curve', amount: -0.25 })).toBe('Curve −25%');
    expect(shapeLabel({ type: 's', steepness: 0.6, bend: 0.7 })).toBe('S 60% · bend at 70%');
    expect(shapeLabel({ type: 's', steepness: -0.3, bend: 0.5 })).toBe('S −30% · bend at 50%');
    expect(shapeLabel(undefined)).toBe('Linear');
    expect(shapeLabel({ type: 'hold' })).toBe('Hold');
  });
});

describe('playback subdivision: error bounded and measured', () => {
  it('the exact chord error matches a brute-force search', () => {
    for (const k of [-24, -5, -1, 0.5, 5, 24]) {
      for (const [u0, u1] of [[0, 1], [0.2, 0.3], [0.9, 1], [0, 0.05]] as const) {
        const e = (u: number) => Math.expm1(k * u) / Math.expm1(k);
        let worst = 0;
        for (let i = 0; i <= 20000; i++) {
          const u = u0 + ((u1 - u0) * i) / 20000;
          worst = Math.max(worst, Math.abs(e(u0) + ((e(u1) - e(u0)) * (u - u0)) / (u1 - u0) - e(u)));
        }
        // (the sampled search can only find less, by its sampling resolution)
        expect(chordError(k, u0, u1)).toBeGreaterThanOrEqual(worst - 1e-15);
        expect(chordError(k, u0, u1)).toBeLessThanOrEqual(worst + 1e-7);
      }
    }
  });

  it('straight lines between the breakpoints stay within 0.1 % of the range of the exact shape, and no sub-ramp moves more than 1/32 of it', () => {
    let worstErr = 0;
    let most = 0;
    for (const s of SHAPES) {
      for (const span of [1, 0.4, 0.05]) {
        const xs = [0, ...shapeBreaks(s, span), 1];
        most = Math.max(most, xs.length - 2);
        for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThan(xs[i - 1]!);
        const fs = xs.map((x) => shapeFrac(s, x));
        for (let i = 1; i < fs.length; i++) expect((fs[i]! - fs[i - 1]!) * span).toBeLessThanOrEqual(PLAYBACK_MAX_STEP + 1e-12);
        let j = 0;
        let worst = 0;
        for (let i = 0; i <= 20000; i++) {
          const x = i / 20000;
          while (j < xs.length - 2 && xs[j + 1]! < x) j++;
          const line = fs[j]! + ((fs[j + 1]! - fs[j]!) * (x - xs[j]!)) / (xs[j + 1]! - xs[j]!);
          worst = Math.max(worst, Math.abs(line - shapeFrac(s, x)) * span);
        }
        expect(worst, `${JSON.stringify(s)} span ${span}`).toBeLessThanOrEqual(PLAYBACK_EPS + 1e-12);
        worstErr = Math.max(worstErr, worst);
      }
    }
    // cheap: a full-range segment needs at most a few dozen breakpoints, whatever the shape
    expect(most).toBeLessThanOrEqual(80);
    expect(worstErr).toBeGreaterThan(PLAYBACK_EPS / 4); // (the bound is used, not overshot by a mile)
  });

  it('a lane without shapes plays its own points (the very same array); a hold becomes a flat ramp and a step', () => {
    const pts: AutomationPoint[] = [{ id: 'a', tick: 0, value: 0.2 }, { id: 'b', tick: 1920, value: 0.8 }];
    expect(playbackPoints(pts, UNIT)).toBe(pts);
    const held = playbackPoints([{ ...pts[0]!, shape: { type: 'hold' } }, pts[1]!], UNIT);
    expect(held.map((p) => [p.tick, p.value])).toEqual([[0, 0.2], [1920, 0.2], [1920, 0.8]]);
    // (an S with steepness 0 or a curve of 0 is straight: nothing added)
    expect(playbackPoints([{ ...pts[0]!, shape: { type: 's', steepness: 0, bend: 0.3 } }, pts[1]!], UNIT).length).toBe(2);
  });

  it('exp-curve parameters bend on their log scale: breakpoints sit on the shape in log space, within the bound', () => {
    const pts: AutomationPoint[] = [{ id: 'a', tick: 0, value: 100, shape: { type: 's', steepness: 0.8, bend: 0.3 } }, { id: 'b', tick: 7680, value: 10000 }];
    const out = playbackPoints(pts, HZ);
    expect(out.length).toBeGreaterThan(10);
    const span = domainPos(HZ, 10000) - domainPos(HZ, 100);
    for (const p of out) {
      const x = p.tick / 7680;
      expect(domainPos(HZ, p.value) - domainPos(HZ, 100)).toBeCloseTo(shapeFrac(pts[0]!.shape, x) * span, 10);
    }
    // between them (geometric, as an exponential ramp plays): within 0.1 % of the range
    for (let t = 0; t <= 7680; t += 3) {
      const played = valueAt(out, t, HZ)!;
      const exact = valueAt(pts, t, HZ)!;
      expect(Math.abs(domainPos(HZ, played) - domainPos(HZ, exact))).toBeLessThanOrEqual(PLAYBACK_EPS + 1e-9);
    }
  });
});

describe('exp-curve lanes interpolate on their log scale (as drawn and as the ramps play)', () => {
  const lin: AutomationPoint[] = [{ id: 'a', tick: 0, value: 100 }, { id: 'b', tick: 1920, value: 10000 }];

  it('a straight segment from 100 Hz to 10 kHz is at 1 kHz halfway — not 5 050 Hz', () => {
    expect(valueAt(lin, 960, HZ)).toBeCloseTo(1000, 6);
    // linear parameters are unchanged
    expect(valueAt([{ id: 'a', tick: 0, value: -60 }, { id: 'b', tick: 1920, value: 0 }], 960, DB)).toBeCloseTo(-30, 9);
  });

  it('a fresh start (play, seek, loop wrap) inside such a segment starts from that value', () => {
    const p = createProject();
    const t = p.tracks[0]!;
    t.automation = [{ ...createLane({ kind: 'track', param: 'volumeDb' }, 0, 0), points: lin }];
    const ctx: PlanContext = { bpm: BPM, loop: p.loop, beatTicks: 960, barTicks: BAR, metronome: false, tracks: p.tracks, clips: [], laneSpec: () => HZ };
    const plan = planWindow(ctx, { tick: 960, time: 0, fresh: true }, 0.15);
    expect(plan.automation[0]!.events[0]!.kind).toBe('set');
    expect(plan.automation[0]!.events[0]!.value).toBeCloseTo(1000, 6);
  });

  it('the sampler and drum rack read exp-curve ramps geometrically at a hit', () => {
    const ramps = [{ t0: 1, v0: 0.05, t1: 3, v1: 2, exp: true }];
    expect(rampValueAt(ramps, 2, null)).toBeCloseTo(Math.sqrt(0.05 * 2), 9);
    expect(rampValueAt([{ ...ramps[0]!, exp: false }], 2, null)).toBeCloseTo(1.025, 9);
    expect(rampValueAt(ramps, 0.5, 7)).toBe(7);
    expect(rampValueAt(ramps, 4, 7)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// scheduling: live windows vs export, window and loop boundaries
// ---------------------------------------------------------------------------

/** a lane through every shape, on a parameter with the given range */
function shapedLane(spec: NumericParamSpec, id: string): AutomationLane {
  const v = (n: number) => (spec.curve === 'exp' ? spec.min * Math.pow(spec.max / spec.min, n) : spec.min + (spec.max - spec.min) * n);
  const points: AutomationPoint[] = [
    { id: `${id}0`, tick: 0, value: v(0.1), shape: { type: 'curve', amount: 0.8 } },
    { id: `${id}1`, tick: 2 * BAR - 7, value: v(0.9), shape: { type: 's', steepness: 0.9, bend: 0.72 } },
    { id: `${id}2`, tick: 3 * BAR + 333, value: v(0.05), shape: { type: 'hold' } },
    { id: `${id}3`, tick: 4 * BAR, value: v(0.6), shape: { type: 'curve', amount: -1 } },
    { id: `${id}4`, tick: 5 * BAR + 100, value: v(0.2), shape: { type: 's', steepness: -0.8, bend: 0.25 } },
    { id: `${id}5`, tick: 6 * BAR, value: v(1) },
    { id: `${id}6`, tick: 6 * BAR + 960, value: v(0.4) },
  ];
  return { id, target: { kind: 'track', param: 'volumeDb' }, enabled: true, points };
}

const SPECS: Record<string, NumericParamSpec> = { db: DB, hz: HZ, unit: UNIT };

function ctxFor(loop: PlanContext['loop']): PlanContext {
  return {
    bpm: BPM,
    loop,
    beatTicks: 960,
    barTicks: BAR,
    metronome: false,
    tracks: Object.keys(SPECS).map((k) => ({ id: k, kind: 'audio' as const, automation: [shapedLane(SPECS[k]!, k)] })),
    clips: [],
    laneSpec: (trackId) => SPECS[trackId] ?? null,
  };
}

/** What an AudioParam holds at t given set / ramp events (exp: exponential ramps), like Web Audio:
 * events in time order, equal times in the order added; a ramp runs from the previous event. */
function paramAt(events: readonly AutomationEvent[], t: number, exp: boolean): number {
  let prev = events[0]!;
  for (const e of events) {
    if (e.time > t) {
      if (e.kind === 'set') return prev.value;
      const f = (t - prev.time) / (e.time - prev.time);
      return exp ? prev.value * Math.pow(e.value / prev.value, f) : prev.value + (e.value - prev.value) * f;
    }
    prev = e;
  }
  return prev.value;
}

/** the transport's windows (25 ms steps, 150 ms ahead), each lane's events kept in order like the transport does */
function liveEvents(loop: PlanContext['loop'], start: Cursor, seconds: number) {
  const ctx = ctxFor(loop);
  const lanes = new Map<string, AutomationEvent[]>();
  let cursor = start;
  for (let now = 0; now < seconds; now += 0.025) {
    const plan = planWindow(ctx, cursor, now + 0.15);
    for (const a of plan.automation) {
      const list = lanes.get(a.trackId) ?? [];
      list.push(...inOrder(a.events, list.at(-1)?.time ?? -Infinity).events);
      lanes.set(a.trackId, list);
    }
    cursor = plan.next;
  }
  return lanes;
}

describe('scheduling curves: live lookahead windows = the export plan', () => {
  const SONG = 6 * BAR + 960;
  const SEC = SONG / 1920;

  it('every shape, on linear, dB and exp-curve parameters: the same curve live and in the export, within 0.1 % of the exact shape', () => {
    const exp = planWindow(ctxFor({ enabled: true, start: 0, end: SONG }), { tick: 0, time: 0, fresh: true }, SEC);
    const live = liveEvents({ enabled: false, start: 0, end: 0 }, { tick: 0, time: 0, fresh: true }, SEC + 0.2);
    for (const k of Object.keys(SPECS)) {
      const spec = SPECS[k]!;
      const isExp = spec.curve === 'exp';
      const e = exp.automation.find((a) => a.trackId === k)!.events;
      const l = live.get(k)!;
      const lane = shapedLane(spec, k);
      let worst = 0;
      for (let t = 0; t < SEC; t += 0.0021) {
        const le = paramAt(l, t, isExp);
        const ee = paramAt(e, t, isExp);
        expect(Math.abs(le - ee), `${k} at ${t.toFixed(4)} s`).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(ee)));
        const err = Math.abs(domainPos(spec, le) - domainPos(spec, valueAt(lane.points, t * 1920, spec)!));
        worst = Math.max(worst, err);
      }
      expect(worst, k).toBeLessThanOrEqual(PLAYBACK_EPS + 1e-9);
      expect(worst, k).toBeGreaterThan(0); // (curves really are subdivided, not skipped)
    }
  });

  it('a hold plays flat, then jumps exactly at the next point', () => {
    const exp = planWindow(ctxFor({ enabled: true, start: 0, end: SONG }), { tick: 0, time: 0, fresh: true }, SEC);
    const e = exp.automation.find((a) => a.trackId === 'unit')!.events;
    const tJump = (4 * BAR) / 1920;
    expect(paramAt(e, tJump - 1e-6, false)).toBeCloseTo(0.05, 9);
    expect(paramAt(e, (3 * BAR + 400) / 1920, false)).toBeCloseTo(0.05, 9);
    expect(paramAt(e, tJump, false)).toBeCloseTo(0.6, 9);
  });

  it('a loop whose ends cut through curves: every pass follows the exact shape, wraps to the loop start, and continues seamlessly across windows', () => {
    const loop = { enabled: true, start: BAR + 1111, end: 5 * BAR + 777 };
    const pass = (loop.end - loop.start) / 1920;
    const live = liveEvents(loop, { tick: loop.start, time: 0, fresh: true }, 3 * pass + 0.1);
    for (const k of Object.keys(SPECS)) {
      const spec = SPECS[k]!;
      const lane = shapedLane(spec, k);
      const l = live.get(k)!;
      // the events never go back in time (Web Audio would reorder them otherwise)
      for (let i = 1; i < l.length; i++) expect(l[i]!.time).toBeGreaterThanOrEqual(l[i - 1]!.time);
      let worst = 0;
      for (let t = 0; t < 3 * pass - 0.002; t += 0.0017) {
        const tick = loop.start + ((t * 1920) % (loop.end - loop.start));
        // (just before a wrap the curve ends at its value at the loop end)
        const err = Math.abs(domainPos(spec, paramAt(l, t, spec.curve === 'exp')) - domainPos(spec, valueAt(lane.points, tick, spec)!));
        worst = Math.max(worst, err);
      }
      expect(worst, k).toBeLessThanOrEqual(PLAYBACK_EPS + 1e-9);
      // at each wrap: back to the value at the loop start (within the bound), and the same every pass
      const atWrap = [1, 2].map((n) => paramAt(l, n * pass + 1e-9, spec.curve === 'exp'));
      for (const v of atWrap) expect(Math.abs(domainPos(spec, v) - domainPos(spec, valueAt(lane.points, loop.start, spec)!))).toBeLessThanOrEqual(PLAYBACK_EPS);
      expect(atWrap[1]).toBeCloseTo(atWrap[0]!, 9);
      expect(paramAt(l, 1e-9, spec.curve === 'exp')).toBeCloseTo(atWrap[0]!, 9);
    }
  });

  it('instrument parameters (worklets, sampler, drum rack) get the same curve as explicit ramp segments', () => {
    const exp = planWindow(ctxFor({ enabled: true, start: 0, end: SONG }), { tick: 0, time: 0, fresh: true }, SEC);
    const a = exp.automation.find((x) => x.trackId === 'hz')!;
    const { segments } = toParamSegments('filter.cutoff', a.events, null, true);
    const ramps = segments.map((s) => ({ t0: s.time, v0: s.fromValue, t1: s.toTime, v1: s.toValue, exp: s.exp }));
    const lane = shapedLane(HZ, 'hz');
    for (let t = 0; t < SEC; t += 0.0031) {
      expect(Math.abs(domainPos(HZ, rampValueAt(ramps, t, null)!) - domainPos(HZ, valueAt(lane.points, t * 1920, HZ)!))).toBeLessThanOrEqual(PLAYBACK_EPS + 1e-9);
    }
  });

  it('every breakpoint is scheduled exactly once across consecutive windows', () => {
    const lane = shapedLane(UNIT, 'unit');
    const played = playbackPoints(lane.points, UNIT);
    let cursor: Cursor = { tick: 0, time: 0, fresh: true };
    const ramps: AutomationEvent[] = [];
    for (let i = 0; i < 600; i++) {
      const { segments, next } = computeSegments(cursor, cursor.time + 0.025, BPM, { enabled: false, start: 0, end: 0 });
      const plan = planWindow({ ...ctxFor({ enabled: false, start: 0, end: 0 }), tracks: [{ id: 'unit', kind: 'audio', automation: [lane] }] }, cursor, cursor.time + 0.025);
      expect(plan.segments).toEqual(segments);
      ramps.push(...plan.automation.flatMap((a) => a.events.filter((e) => e.kind === 'ramp')));
      cursor = next;
    }
    expect(ramps.map((e) => e.value)).toEqual(played.slice(1).map((p) => p.value));
  });
});

// ---------------------------------------------------------------------------
// editing and persistence
// ---------------------------------------------------------------------------

describe('editing keeps shapes', () => {
  const lane = (): AutomationLane => ({
    id: 'L',
    target: { kind: 'track', param: 'volumeDb' },
    enabled: true,
    points: [
      { id: 'a', tick: 0, value: -30, shape: { type: 'curve', amount: 0.5 } },
      { id: 'b', tick: 1920, value: 0, shape: { type: 's', steepness: 0.4, bend: 0.3 } },
      { id: 'c', tick: 3840, value: -12 },
      { id: 'd', tick: 5760, value: -6 },
    ],
  });

  it('moving a point keeps its own shape and its neighbours’', () => {
    const m = movePoint(lane(), 'b', 2500, -3, DB);
    expect(m.points.map((p) => p.shape)).toEqual(lane().points.map((p) => p.shape));
    // dragged past a neighbour: the shapes go with their points
    const past = movePoint(lane(), 'b', 4000, -3, DB);
    expect(past.points.map((p) => p.id)).toEqual(['a', 'c', 'b', 'd']);
    expect(past.points.find((p) => p.id === 'b')!.shape).toEqual({ type: 's', steepness: 0.4, bend: 0.3 });
  });

  it('a point added inside a shaped segment takes its shape (both halves keep the character); elsewhere it is linear', () => {
    const [l1, id1] = addPoint(lane(), 900, -20, DB);
    expect(l1.points.find((p) => p.id === id1)!.shape).toEqual({ type: 'curve', amount: 0.5 });
    const [l2, id2] = addPoint(lane(), 4000, -20, DB);
    expect(l2.points.find((p) => p.id === id2)!.shape).toBeUndefined();
    const [l3, id3] = addPoint(lane(), 9000, -20, DB);
    expect(l3.points.find((p) => p.id === id3)!.shape).toBeUndefined();
  });

  it('a shape change applies to one segment, or to every segment between the selected points', () => {
    const l = lane();
    expect(segmentStarts(l, 'b', [])).toEqual(['b']);
    expect(segmentStarts(l, 'd', [])).toEqual([]); // the last point starts no segment
    expect(segmentStarts(l, 'b', ['a', 'c'])).toEqual(['a', 'b']);
    expect(segmentStarts(l, 'c', ['a', 'b', 'd'])).toEqual(['a', 'b', 'c']);
    expect(segmentStarts(l, 'd', ['a', 'b'])).toEqual([]); // outside the selection: just its own segment
    const h = setShapes(l, ['a', 'b'], { type: 'hold' });
    expect(h.points.map((p) => p.shape?.type)).toEqual(['hold', 'hold', undefined, undefined]);
    const back = setShapes(h, ['a'], undefined);
    expect('shape' in back.points[0]!).toBe(false);
    // a curve of 0 is stored as linear
    expect('shape' in setShapes(l, ['a'], { type: 'curve', amount: 0 }).points[0]!).toBe(false);
  });

  it('save / load keeps shapes and validates them; v3 projects (no shapes) load linear', () => {
    const p = createProject();
    const t = p.tracks[0]!;
    t.automation = [lane()];
    const back = migrateProject(JSON.parse(JSON.stringify(p)));
    expect(back.tracks[0]!.automation[0]!.points).toEqual(lane().points);
    // untrusted values are clamped or dropped
    expect(sanitizeShape({ type: 'curve', amount: 3 })).toEqual({ type: 'curve', amount: 1 });
    expect(sanitizeShape({ type: 's', steepness: -9, bend: 1.5 })).toEqual({ type: 's', steepness: -1, bend: 1 });
    expect(sanitizeShape({ type: 's' })).toEqual({ type: 's', steepness: 0, bend: 0.5 });
    expect(sanitizeShape({ type: 'curve', amount: 0 })).toBeUndefined();
    expect(sanitizeShape({ type: 'linear' })).toBeUndefined();
    expect(sanitizeShape({ type: 'wobble' })).toBeUndefined();
    expect(sanitizeShape('curve')).toBeUndefined();
    const bad = sanitizeLanes([{ ...lane(), points: [{ id: 'x', tick: 0, value: 0, shape: { type: 'curve', amount: Number.NaN } }] }], t);
    expect('shape' in bad[0]!.points[0]!).toBe(false);
    // a v3 file: whatever `shape` it carries isn't ours — it plays linear, exactly as before
    const v3 = migrateProject({ ...JSON.parse(JSON.stringify(p)), schemaVersion: 3 });
    expect(v3.tracks[0]!.automation[0]!.points.every((q) => !('shape' in q))).toBe(true);
    expect(v3.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
  });
});
