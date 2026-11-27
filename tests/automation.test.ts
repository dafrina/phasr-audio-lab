import { describe, expect, it } from 'vitest';
import { computeSegments, planAutomation, planWindow, type AutomationEvent } from '../src/audio/scheduling';
import { createEffectSlot, defaultPeqParams, PEQ_SPECS, sanitizeEffect, FACTORY_EFFECT_PRESETS } from '../src/audio/effects/specs';
import {
  addPoint,
  automatableParams,
  createLane,
  deletePoint,
  movePoint,
  parseBandKey,
  sanitizeLanes,
  staticValue,
  targetInfo,
  valueAt,
  writeValue,
} from '../src/project/automation';
import { createProject } from '../src/project/defaults';
import { migrateProject } from '../src/project/migrations';
import type { AutomationLane, AutomationPoint, EffectSlot } from '../src/project/types';

const BPM = 120; // 1920 ticks per second
const pts = (...a: [number, number][]): AutomationPoint[] => a.map(([tick, value], i) => ({ id: `p${i}`, tick, value }));
const SPEC = PEQ_SPECS.gain;

describe('automation interpolation', () => {
  it('interpolates linearly and holds outside the points', () => {
    const p = pts([960, 0], [1920, 10], [3840, -10]);
    expect(valueAt(p, 0)).toBe(0);
    expect(valueAt(p, 1440)).toBeCloseTo(5, 9);
    expect(valueAt(p, 2880)).toBeCloseTo(0, 9);
    expect(valueAt(p, 99999)).toBe(-10);
    expect(valueAt([], 10)).toBeNull();
  });
  it('treats two points on the same tick as a step', () => {
    const p = pts([0, 0], [960, 0], [960, 6], [1920, 6]);
    expect(valueAt(p, 959)).toBeCloseTo(0, 9);
    expect(valueAt(p, 961)).toBeCloseTo(6, 9);
    expect(valueAt(p, 960)).toBe(6); // at the step: the value after the jump
  });

  it('agrees with the scheduler when a fresh start lands on a step', () => {
    const p = pts([0, 10], [0, 1.3]);
    const ev = planAutomation(p, { startTick: 0, endTick: 300, startTime: 0, fresh: true, hardEndTick: Infinity }, BPM);
    expect(ev).toEqual([{ kind: 'set', time: 0, value: 1.3 }]);
    expect(valueAt(p, 0)).toBe(1.3);
    expect(valueAt(p, 5000)).toBe(1.3);
  });
});

describe('automation point editing', () => {
  it('adds, moves (keeping order and clamping) and deletes points', () => {
    let lane = createLane({ kind: 'track', param: 'pan' }, 0, 0);
    const [l2, id] = addPoint(lane, 1920, 50, SPEC);
    lane = l2;
    expect(lane.points.map((p) => p.tick)).toEqual([0, 1920]);
    expect(lane.points[1]?.value).toBe(24); // clamped to spec max
    lane = movePoint(lane, id, -100, -3, SPEC);
    expect(lane.points.find((p) => p.id === id)).toMatchObject({ tick: 0, value: -3 });
    lane = deletePoint(lane, id);
    expect(lane.points).toHaveLength(1);
  });

  it('writes a knob sweep while playing as a clean curve', () => {
    let lane: AutomationLane = { ...createLane({ kind: 'track', param: 'pan' }, 0, 0), points: pts([0, 0], [500, 3], [800, 9], [5000, 1]) };
    // gesture: first write at 400 (no previous), then 600, then 900
    lane = writeValue(lane, null, 400, 2, SPEC);
    lane = writeValue(lane, 400, 600, 4, SPEC);
    lane = writeValue(lane, 600, 900, 6, SPEC);
    expect(lane.points.map((p) => [p.tick, p.value])).toEqual([[0, 0], [400, 2], [600, 4], [900, 6], [5000, 1]]);
  });

  it('replaces a nearby point when writing while stopped', () => {
    const lane = { ...createLane({ kind: 'track', param: 'pan' }, 0, 0), points: pts([0, 0], [1000, 5]) };
    const w = writeValue(lane, null, 1010, 7, SPEC, 30);
    expect(w.points.map((p) => [p.tick, p.value])).toEqual([[0, 0], [1010, 7]]);
  });
});

describe('automation scheduling', () => {
  const seg = (startTick: number, endTick: number, fresh: boolean, hardEndTick = Infinity) => ({ startTick, endTick, startTime: startTick / 1920, fresh, hardEndTick });

  it('a fresh start sets the current value and ramps toward the next point even beyond the window', () => {
    const p = pts([0, 0], [3840, 12]);
    const ev = planAutomation(p, seg(960, 1248, true), BPM);
    expect(ev[0]).toEqual({ kind: 'set', time: 0.5, value: 3 });
    expect(ev[1]).toEqual({ kind: 'ramp', time: 2, value: 12 });
    expect(ev).toHaveLength(2);
  });

  it('schedules every ramp exactly once across consecutive windows', () => {
    const p = pts([0, 0], [500, 4], [1000, -4], [3000, 8]);
    const loop = { enabled: false, start: 0, end: 3840 };
    let cursor = { tick: 0, time: 0, fresh: true };
    const all: AutomationEvent[] = [];
    for (let i = 0; i < 40; i++) {
      const { segments, next } = computeSegments(cursor, cursor.time + 0.025, BPM, loop);
      for (const s of segments) all.push(...planAutomation(p, s, BPM));
      cursor = next;
    }
    const ramps = all.filter((e) => e.kind === 'ramp').map((e) => e.value);
    expect(ramps).toEqual([4, -4, 8]);
    expect(all.filter((e) => e.kind === 'set')).toHaveLength(1);
  });

  it('stops ramps at the loop end with the interpolated value, then restarts at the loop start', () => {
    const p = pts([0, 0], [3840, 8]);
    const loop = { enabled: true, start: 0, end: 1920 };
    const { segments } = computeSegments({ tick: 1800, time: 0, fresh: false }, 0.2, BPM, loop);
    const ev = segments.flatMap((s) => planAutomation(p, s, BPM));
    // wrap segment is fresh: set back to the value at the loop start (0), ramp toward 8 but only to loop end (value 4)
    expect(ev[0]).toMatchObject({ kind: 'set', value: 0 });
    expect(ev[1]).toMatchObject({ kind: 'ramp', value: 4 });
    expect(ev[1]?.time).toBeCloseTo(ev[0]!.time + 1, 9);
  });

  it('planWindow emits automation for enabled lanes only', () => {
    const p = createProject();
    const t = p.tracks[0];
    if (!t) throw new Error();
    t.automation = [
      { ...createLane({ kind: 'track', param: 'volumeDb' }, -6, 0), points: pts([0, -60], [1920, 0]) },
      { ...createLane({ kind: 'track', param: 'pan' }, 0, 0), enabled: false },
    ];
    const plan = planWindow(
      { bpm: BPM, loop: p.loop, beatTicks: 960, barTicks: 3840, metronome: false, tracks: p.tracks, clips: [] },
      { tick: 0, time: 0, fresh: true },
      0.15,
    );
    expect(plan.automation).toHaveLength(1);
    expect(plan.automation[0]?.events[0]).toEqual({ kind: 'set', time: 0, value: -60 });
    expect(plan.automation[0]?.events[1]).toEqual({ kind: 'ramp', time: 1, value: 0 });
  });
});

describe('automation targets and persistence', () => {
  it('lists automatable params per effect, including enabled Spectra EQ bands', () => {
    const peq = createEffectSlot('peq') as Extract<EffectSlot, { type: 'peq' }>;
    expect(automatableParams(peq).map((p) => p.key)).toEqual(['output']);
    const b = peq.params.bands;
    b[2] = { ...b[2]!, enabled: true, type: 'bell' };
    b[5] = { ...b[5]!, enabled: true, type: 'highshelf' };
    b[0] = { ...b[0]!, enabled: true, type: 'lowcut', slope: 48 };
    expect(automatableParams(peq).map((p) => p.key)).toEqual(['b0.freq', 'b2.freq', 'b2.gain', 'b2.q', 'b5.freq', 'b5.gain', 'output']);
    expect(parseBandKey('b7.q')).toEqual({ band: 7, field: 'q' });
    expect(parseBandKey('b8.q')).toBeNull();
    const delay = createEffectSlot('delay');
    expect(automatableParams(delay).map((p) => p.key)).toEqual(['feedback', 'mix']); // synced → no time
  });

  it('resolves labels and static values, and drops lanes whose target is gone', () => {
    const p = createProject();
    const t = p.tracks[0];
    if (!t) throw new Error();
    const rev = createEffectSlot('reverb');
    t.effects = [rev];
    expect(targetInfo(t, { kind: 'fx', slotId: rev.id, param: 'mix' })?.fullLabel).toBe('Reverb Pro · Mix');
    expect(staticValue(t, { kind: 'fx', slotId: rev.id, param: 'mix' })).toBe(0.25);
    expect(staticValue(t, { kind: 'track', param: 'volumeDb' })).toBe(-6);
    const lanes = sanitizeLanes(
      [
        { target: { kind: 'fx', slotId: rev.id, param: 'mix' }, points: [{ tick: 10, value: 5 }, { tick: 'x' }] },
        { target: { kind: 'fx', slotId: 'gone', param: 'mix' }, points: [] },
        { target: { kind: 'fx', slotId: rev.id, param: 'decay' }, points: [] }, // not automatable
        { target: { kind: 'track', param: 'pan' }, points: [{ tick: 5, value: 0.5 }, { tick: 1, value: -0.5 }] },
      ],
      t,
    );
    expect(lanes).toHaveLength(2);
    expect(lanes[0]?.points).toEqual([{ id: expect.any(String), tick: 10, value: 1 }]); // clamped to mix max
    expect(lanes[1]?.points.map((x) => x.tick)).toEqual([1, 5]); // sorted
  });

  it('round-trips a project with Spectra EQ and automation lanes', () => {
    const p = createProject();
    const t = p.tracks[1];
    if (!t) throw new Error();
    const peq = createEffectSlot('peq');
    if (peq.type !== 'peq') throw new Error();
    peq.params.bands[3] = { enabled: true, type: 'bell', freq: 2500, gain: 4, q: 2, slope: 24 };
    t.effects = [peq];
    t.automation = [{ ...createLane({ kind: 'fx', slotId: peq.id, param: 'b3.gain' }, 4, 0), points: pts([0, 4], [3840, -6]) }];
    const back = migrateProject(JSON.parse(JSON.stringify(p)));
    expect(back.tracks[1]?.effects).toEqual(t.effects);
    expect(back.tracks[1]?.automation).toEqual(t.automation);
  });

  it('sanitizes Spectra EQ params and has valid presets', () => {
    const s = sanitizeEffect({ type: 'peq', params: { bands: [{ enabled: true, type: 'weird', freq: 5, gain: 99, q: 0, slope: 7 }], output: 50 } });
    if (!s || s.type !== 'peq') throw new Error();
    expect(s.params.bands).toHaveLength(8);
    expect(s.params.bands[0]).toEqual({ enabled: true, type: 'bell', freq: 20, gain: 24, q: 0.1, slope: 24 });
    expect(s.params.output).toBe(24);
    expect(defaultPeqParams().bands.every((b) => !b.enabled)).toBe(true);
    for (const pr of FACTORY_EFFECT_PRESETS.filter((x) => x.type === 'peq')) {
      expect(sanitizeEffect({ type: 'peq', params: pr.params })?.params, pr.name).toEqual(pr.params);
    }
  });
});
