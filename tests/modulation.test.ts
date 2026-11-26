import { describe, expect, it } from 'vitest';
import { ModSourceCore, RANGE_DB, type ModSettings } from '../src/audio/modsource/ModSourceCore';
import { createEffectSlot } from '../src/audio/effects/specs';
import { createProject, createTrack } from '../src/project/defaults';
import { migrateProject } from '../src/project/migrations';
import { createRoute, isModulatable, modParamInfo, sourceKinds, wouldCreateCycle } from '../src/project/modulation';
import type { ModRoute, Project, Track } from '../src/project/types';
import { removeTrack, useProjectStore } from '../src/state/projectStore';

const SR = 48000;
const BLOCK = 128;

function settings(o: Partial<ModSettings> = {}): ModSettings {
  return { mode: 'audio', attack: 0.005, release: 0.1, threshold: -30, hold: 0, invert: false, ...o };
}

/** Run the core over `frames`, feeding a constant-amplitude sidechain signal from `amp(frame)`. */
function run(core: ModSourceCore, frames: number, amp: (f: number) => number = () => 0, start = 0): Float32Array {
  const out = new Float32Array(frames);
  const l = new Float32Array(BLOCK);
  const blk = new Float32Array(BLOCK);
  for (let i = 0; i < frames; i += BLOCK) {
    for (let k = 0; k < BLOCK; k++) l[k] = amp(start + i + k) * (k % 2 ? -1 : 1); // alternating sign: |x| = amp
    core.process(start + i, l, l, blk);
    out.set(blk.subarray(0, Math.min(BLOCK, frames - i)), i);
  }
  return out;
}

describe('envelope follower (audio sidechain)', () => {
  it('stays closed below the threshold and opens fully 12 dB above it', () => {
    const quiet = run(new ModSourceCore(SR, settings()), 4800, () => 10 ** (-40 / 20));
    expect(Math.max(...quiet)).toBeLessThan(1e-6);
    const loud = run(new ModSourceCore(SR, settings()), 9600, () => 10 ** ((-30 + RANGE_DB + 3) / 20));
    expect(loud[loud.length - 1]).toBeGreaterThan(0.99);
    const half = run(new ModSourceCore(SR, settings()), 9600, () => 10 ** ((-30 + RANGE_DB / 2) / 20));
    expect(half[half.length - 1]).toBeCloseTo(0.5, 2);
  });

  it('follows with the attack time and decays with the release time', () => {
    const core = new ModSourceCore(SR, settings({ attack: 0.01, release: 0.2 }));
    const on = run(core, SR / 10, () => 1); // 0 dBFS → fully open
    // one-pole: ~63 % after one attack time
    expect(on[Math.round(0.01 * SR)]).toBeGreaterThan(0.55);
    expect(on[Math.round(0.01 * SR)]).toBeLessThan(0.72);
    const off = run(core, SR / 2, () => 0, SR / 10);
    expect(off[Math.round(0.2 * SR)]).toBeGreaterThan(0.3); // ~37 % after one release time
    expect(off[Math.round(0.2 * SR)]).toBeLessThan(0.42);
    expect(off[off.length - 1]).toBeLessThan(0.1);
  });

  it('inverts', () => {
    const out = run(new ModSourceCore(SR, settings({ invert: true })), 2400);
    expect(out[0]).toBe(1);
  });
});

describe('MIDI trigger envelope', () => {
  const midi = (o: Partial<ModSettings> = {}) => new ModSourceCore(SR, settings({ mode: 'midi', attack: 0.002, hold: 0.05, release: 0.1, ...o }));

  it('starts on the exact trigger frame, ramps linearly, holds, then releases', () => {
    const core = midi();
    core.trigger(1000);
    const out = run(core, SR / 2);
    expect(out[999]).toBe(0);
    expect(out[1000]).toBeGreaterThan(0);
    expect(out[1000 + 48]).toBeCloseTo(0.5, 1); // half way through a 2 ms (96-frame) attack
    expect(out[1000 + 96 + 100]).toBe(1); // holding
    const relStart = 1000 + 96 + Math.round(0.05 * SR);
    const atRelease = out[relStart + Math.round(0.1 * SR)] as number;
    expect(atRelease).toBeGreaterThan(0.33); // one time constant → ~37 %, same as the audio follower
    expect(atRelease).toBeLessThan(0.41);
    expect(out[out.length - 1]).toBeLessThan(0.05);
  });

  it('retriggers from the current value without jumping', () => {
    const core = midi({ attack: 0.01 });
    core.trigger(0);
    core.trigger(Math.round(0.08 * SR)); // during the release of the first hit
    const out = run(core, SR / 5);
    const t = Math.round(0.08 * SR);
    expect(Math.abs((out[t] as number) - (out[t - 1] as number))).toBeLessThan(0.01);
    expect(out[t + Math.round(0.01 * SR)]).toBeCloseTo(1, 2);
  });

  it('cancel drops future triggers', () => {
    const core = midi();
    core.trigger(100);
    core.trigger(20000);
    core.cancel(10000);
    const out = run(core, 30000);
    expect(out[150]).toBeGreaterThan(0);
    // no new attack after the cancelled trigger: the envelope only keeps decaying
    expect(Math.max(...out.subarray(20000))).toBeLessThanOrEqual(out[19999] as number);
  });
});

describe('routes, cycles and persistence', () => {
  function proj(): { p: Project; a: Track; b: Track; inst: Track } {
    const p = createProject();
    const a = p.tracks[0] as Track; // audio
    const inst = p.tracks[1] as Track; // instrument
    const b = createTrack('audio', 2);
    p.tracks.push(b);
    return { p, a, b, inst };
  }

  it('lists modulatable targets and source kinds', () => {
    const { a, inst } = proj();
    expect(sourceKinds(inst)).toEqual(['midi', 'audio']);
    expect(sourceKinds(a)).toEqual(['audio']);
    expect(isModulatable(a, { kind: 'track', param: 'volumeDb' })).toBe(true);
    const eq = createEffectSlot('eq');
    a.effects = [eq, createEffectSlot('reverb')];
    expect(modParamInfo(a, { kind: 'fx', slotId: eq.id, param: 'midFreq' })?.depth.format(12)).toBe('+12.0 st');
    // ducked reverb: its wet level is a sidechain target; its decay is not (a new impulse response per change)
    expect(isModulatable(a, { kind: 'fx', slotId: a.effects[1]!.id, param: 'mix' })).toBe(true);
    expect(isModulatable(a, { kind: 'fx', slotId: a.effects[1]!.id, param: 'decay' })).toBe(false);
  });

  it('offers wet level, pre-delay, chorus rate/depth and EQ band Q as sidechain targets', () => {
    const { a } = proj();
    const rev = createEffectSlot('reverb');
    const del = createEffectSlot('delay');
    const cho = createEffectSlot('chorus');
    const peq = createEffectSlot('peq');
    if (peq.type !== 'peq') throw new Error('peq');
    peq.params.bands[0] = { ...peq.params.bands[0]!, enabled: true, type: 'bell' };
    peq.params.bands[1] = { ...peq.params.bands[1]!, enabled: true, type: 'lowcut' };
    a.effects = [rev, del, cho, peq];
    const keys = (id: string) => ['mix', 'preDelay', 'feedback', 'rate', 'depth', 'b0.q', 'b1.q', 'b0.gain'].filter((k) => isModulatable(a, { kind: 'fx', slotId: id, param: k }));
    expect(keys(rev.id)).toEqual(['mix', 'preDelay']);
    expect(keys(del.id)).toEqual(['mix', 'feedback']);
    expect(keys(cho.id)).toEqual(['mix', 'rate', 'depth']);
    // Q only where it is a width (bell), not a cut's resonance
    expect(keys(peq.id)).toEqual(['b0.q', 'b0.gain']);
    expect(modParamInfo(a, { kind: 'fx', slotId: rev.id, param: 'mix' })?.depth.default).toBe(-12);
    expect(modParamInfo(a, { kind: 'fx', slotId: cho.id, param: 'rate' })?.depth.format(1)).toBe('+1.00 oct');
  });

  it('detects audio feedback cycles but allows MIDI routes and self-ducking', () => {
    const { p, a, b, inst } = proj();
    const vol = { kind: 'track', param: 'volumeDb' } as const;
    const ab = createRoute(b, a.id, 'audio', vol) as ModRoute; // a's audio ducks b
    b.modulations = [ab];
    expect(wouldCreateCycle(p, a.id, { sourceTrackId: b.id, source: 'audio', target: vol })).toBe(true);
    expect(wouldCreateCycle(p, a.id, { sourceTrackId: inst.id, source: 'audio', target: vol })).toBe(false);
    expect(wouldCreateCycle(p, a.id, { sourceTrackId: b.id, source: 'midi', target: vol })).toBe(false);
    // self: volume duck is after the tap (ok); any other own-audio target loops
    expect(wouldCreateCycle(p, a.id, { sourceTrackId: a.id, source: 'audio', target: vol })).toBe(false);
    expect(wouldCreateCycle(p, a.id, { sourceTrackId: a.id, source: 'audio', target: { kind: 'track', param: 'pan' } })).toBe(true);
    // longer chain: a → b, b → inst, then inst → a closes the loop
    inst.modulations = [createRoute(inst, b.id, 'audio', vol) as ModRoute];
    expect(wouldCreateCycle(p, a.id, { sourceTrackId: inst.id, source: 'audio', target: vol })).toBe(true);
  });

  it('round-trips routes and drops invalid ones (missing source, bad kind, cycles)', () => {
    const { p, a, b, inst } = proj();
    const vol = { kind: 'track', param: 'volumeDb' } as const;
    b.modulations = [{ ...(createRoute(b, inst.id, 'midi', vol) as ModRoute), depth: -18, hold: 0.1 }];
    const raw = JSON.parse(JSON.stringify(p));
    raw.tracks[0].modulations = [
      { ...createRoute(a, 'ghost', 'audio', vol) }, // missing source
      { ...createRoute(a, b.id, 'midi', vol) }, // audio track has no MIDI
      { ...createRoute(a, b.id, 'audio', vol), depth: -999 }, // valid, depth clamped
    ];
    raw.tracks[2].modulations.push({ ...createRoute(b, a.id, 'audio', vol) }); // a→b … but b→a exists above → cycle, dropped
    const back = migrateProject(raw);
    expect(back.tracks[2]?.modulations).toHaveLength(1);
    expect(back.tracks[2]?.modulations[0]).toMatchObject({ source: 'midi', depth: -18, hold: 0.1 });
    expect(back.tracks[0]?.modulations).toHaveLength(1);
    expect(back.tracks[0]?.modulations[0]?.depth).toBe(-48);
  });

  it('deleting a source track removes the routes that used it', () => {
    const { p, a, b } = proj();
    b.modulations = [createRoute(b, a.id, 'audio', { kind: 'track', param: 'volumeDb' }) as ModRoute];
    useProjectStore.getState().loadProject(p);
    removeTrack(a.id);
    const after = useProjectStore.getState().project.tracks.find((t) => t.id === b.id);
    expect(after?.modulations).toEqual([]);
  });
});
