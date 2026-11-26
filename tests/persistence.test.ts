import { describe, expect, it } from 'vitest';
import { buildArchive, parseArchive, ArchiveFormatError, extForMime } from '../src/persistence/archive';
import { writeZip } from '../src/persistence/zip';
import { safeFileName } from '../src/persistence/download';
import { estimateTailSeconds, exportRange, trackAudibleFn, ExportRangeError } from '../src/audio/exportPlan';
import { toParamSegments } from '../src/audio/scheduling';
import { createEffectSlot, defaultParams, sanitizeEffect } from '../src/audio/effects/specs';
import { createAudioClip, createMidiClip, createProject, createTrack } from '../src/project/defaults';
import { createLane, sanitizeLanes, staticValue, targetInfo } from '../src/project/automation';
import { INSTRUMENTS, instrumentAutoParams } from '../src/instruments/definitions';
import { TriOscCore, setPatchPath } from '../src/synth/dsp/TriOscCore';
import { defaultPatch } from '../src/synth/params';
import { PITCH_BEND_KEY } from '../src/synth/dsp/bend';
import type { Project } from '../src/project/types';

function projectWithAudio(): { p: Project; assetId: string } {
  const p = createProject('Archive Test');
  const assetId = 'ast_test1';
  p.assets[assetId] = { id: assetId, name: 'Loop', sampleRate: 48000, channels: 2, durationSec: 2, frames: 96000 };
  const c = createAudioClip(p.tracks[0]!.id, assetId, 'Loop', 0, 3840);
  p.clips[c.id] = c;
  return { p, assetId };
}

describe('project archive', () => {
  it('round-trips project and audio bytes, giving the import a new id', async () => {
    const { p, assetId } = projectWithAudio();
    const bytes = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4, 5]);
    const zip = buildArchive(p, [{ id: assetId, mime: 'audio/wav', bytes }]);
    const back = await parseArchive(zip);
    expect(back.project.id).not.toBe(p.id);
    expect({ ...back.project, id: p.id }).toEqual(p);
    expect(back.assets).toEqual([{ id: assetId, mime: 'audio/wav', bytes }]);
    expect(back.missing).toEqual([]);
  });

  it('reports audio missing from the archive', async () => {
    const { p, assetId } = projectWithAudio();
    const back = await parseArchive(buildArchive(p, []));
    expect(back.missing).toEqual([assetId]);
  });

  it('rejects non-archives with a clear error', async () => {
    await expect(parseArchive(new TextEncoder().encode('hello'))).rejects.toThrow(ArchiveFormatError);
    const noManifest = writeZip([{ name: 'x.txt', data: new Uint8Array([1]) }]);
    await expect(parseArchive(noManifest)).rejects.toThrow(/manifest/);
    const wrong = writeZip([{ name: 'manifest.json', data: new TextEncoder().encode('{"format":"other"}') }]);
    await expect(parseArchive(wrong)).rejects.toThrow(/Not a PHASR/);
  });

  it('maps mime types to extensions and sanitizes file names', () => {
    expect(extForMime('audio/wav')).toBe('wav');
    expect(extForMime('audio/mpeg')).toBe('mp3');
    expect(extForMime('weird/thing')).toBe('bin');
    expect(safeFileName('My: Song / v2?')).toBe('My_ Song _ v2_');
    expect(safeFileName('   ')).toBe('project');
  });
});

describe('export planning', () => {
  it('computes song and loop ranges, and errors when there is nothing to export', () => {
    const p = createProject();
    expect(() => exportRange(p, 'song')).toThrow(ExportRangeError);
    const c = createMidiClip(p.tracks[1]!.id, 3840, 7680);
    p.clips[c.id] = c;
    expect(exportRange(p, 'song')).toEqual({ startTick: 0, endTick: 11520, seconds: 6 });
    p.loop = { enabled: true, start: 1920, end: 5760 };
    expect(exportRange(p, 'loop')).toEqual({ startTick: 1920, endTick: 5760, seconds: 2 });
    p.loop = { enabled: true, start: 100, end: 100 };
    expect(() => exportRange(p, 'loop')).toThrow(/empty/);
  });

  it('estimates tails from releases and effects, skipping inaudible tracks', () => {
    const p = createProject();
    const inst = p.tracks[1]!;
    if (inst.instrument?.type !== 'triosc') throw new Error();
    inst.instrument.patch.ampEnv.release = 2;
    const rev = createEffectSlot('reverb');
    inst.effects = [rev];
    const tail = estimateTailSeconds(p, trackAudibleFn(p));
    expect(tail).toBeCloseTo(2 + 0.02 + 2.2 + 0.05 + 0.25, 6);
    inst.mute = true;
    expect(estimateTailSeconds(p, trackAudibleFn(p))).toBeCloseTo(0.25, 6);
  });
});

describe('instrument parameter automation', () => {
  it('lists automatable TriOsc and drum pad parameters with static values', () => {
    const keys = instrumentAutoParams(INSTRUMENTS.triosc.createConfig()).map((p) => p.key);
    for (const k of ['ampEnv.release', 'filter.cutoff', 'filter.resonance', 'filterEnv.decay', 'lfo.rate', 'osc1.level', 'master']) expect(keys).toContain(k);
    const p = createProject();
    const t = p.tracks[1]!;
    expect(staticValue(t, { kind: 'inst', param: 'ampEnv.release' })).toBe(0.25);
    expect(targetInfo(t, { kind: 'inst', param: 'filter.cutoff' })?.fullLabel).toBe('TriOsc · Cutoff');
    const drums = createTrack('instrument', 2, INSTRUMENTS.drumrack.createConfig());
    expect(staticValue(drums, { kind: 'inst', param: 'p2.tune' })).toBe(0);
    expect(targetInfo(drums, { kind: 'inst', param: 'p0.decay' })?.fullLabel).toBe('Drum Rack · Kick Decay');
    const lanes = sanitizeLanes([createLane({ kind: 'inst', param: 'filter.cutoff' }, 800), createLane({ kind: 'inst', param: 'nope.x' }, 1)], t);
    expect(lanes.map((l) => l.target)).toEqual([{ kind: 'inst', param: 'filter.cutoff' }]);
  });

  it('offers a Pitch Bend lane on the melodic instruments (not the Drum Rack)', () => {
    for (const type of ['triosc', 'keys', 'sampler'] as const) {
      const cfg = INSTRUMENTS[type].createConfig();
      const bend = instrumentAutoParams(cfg).find((p) => p.key === PITCH_BEND_KEY);
      expect(bend?.label).toBe('Pitch Bend');
      expect([bend?.spec.min, bend?.spec.max, bend?.spec.default]).toEqual([-1, 1, 0]);
      const t = createTrack('instrument', 0, cfg);
      // a new lane starts centred, and survives loading
      expect(staticValue(t, { kind: 'inst', param: PITCH_BEND_KEY })).toBe(0);
      expect(sanitizeLanes([createLane({ kind: 'inst', param: PITCH_BEND_KEY }, 0)], t)).toHaveLength(1);
    }
    expect(instrumentAutoParams(INSTRUMENTS.drumrack.createConfig()).some((p) => p.key === PITCH_BEND_KEY)).toBe(false);
    // shown in semitones for the instrument's own bend range
    const tri = INSTRUMENTS.triosc.createConfig();
    tri.patch.voice.bendRange = 12;
    expect(instrumentAutoParams(tri).find((p) => p.key === PITCH_BEND_KEY)?.spec.format(-0.5)).toBe('-6.00 st');
    expect(instrumentAutoParams(INSTRUMENTS.keys.createConfig()).find((p) => p.key === PITCH_BEND_KEY)?.spec.format(1)).toBe('+2.00 st');
    expect(targetInfo(createTrack('instrument', 0, tri), { kind: 'inst', param: PITCH_BEND_KEY })?.fullLabel).toBe('TriOsc · Pitch Bend');
  });

  it('turns planned events into ramp segments that continue across passes', () => {
    const a = toParamSegments('filter.cutoff', [{ kind: 'set', time: 0, value: 200 }, { kind: 'ramp', time: 1, value: 2000 }], null, true);
    expect(a.segments).toEqual([
      { type: 'param', time: 0, key: 'filter.cutoff', fromValue: 200, toTime: 0, toValue: 200, exp: true },
      { type: 'param', time: 0, key: 'filter.cutoff', fromValue: 200, toTime: 1, toValue: 2000, exp: true },
    ]);
    const b = toParamSegments('filter.cutoff', [{ kind: 'ramp', time: 3, value: 500 }], a.last, true);
    expect(b.segments[0]).toMatchObject({ time: 1, fromValue: 2000, toTime: 3, toValue: 500 });
  });

  it('TriOsc applies automation ramps sample-block-accurately and keeps them over static edits', () => {
    const SR = 48000;
    const core = new TriOscCore(SR, defaultPatch());
    core.handleMessage({ type: 'autoKeys', keys: ['ampEnv.release', 'filter.cutoff'] });
    core.handleMessage({ type: 'param', time: 0, key: 'ampEnv.release', fromValue: 0.1, toTime: 1, toValue: 2.1, exp: false });
    core.handleMessage({ type: 'param', time: 0, key: 'filter.cutoff', fromValue: 100, toTime: 1, toValue: 10000, exp: true });
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    for (let f = 0; f < SR / 2; f += 128) core.process(f, l, r);
    const p = core.synth.getPatch();
    expect(p.ampEnv.release).toBeCloseTo(1.1, 1); // linear halfway
    expect(p.filter.cutoff).toBeCloseTo(1000, -2); // exponential halfway = geometric mean
    // a static patch edit from the UI must not override the automated values
    core.handleMessage({ type: 'patch', patch: { ...defaultPatch(), master: 0.3 } });
    expect(core.synth.getPatch().master).toBe(0.3);
    expect(core.synth.getPatch().ampEnv.release).toBeCloseTo(1.1, 1);
    // dropping the lane hands the parameter back to the static value
    core.handleMessage({ type: 'autoKeys', keys: [] });
    core.handleMessage({ type: 'patch', patch: defaultPatch() });
    expect(core.synth.getPatch().ampEnv.release).toBe(defaultPatch().ampEnv.release);
  });

  it('sets dotted patch paths and refuses unknown ones', () => {
    const p = defaultPatch();
    expect(setPatchPath(p, 'osc2.pan', -0.5)).toBe(true);
    expect(p.oscs[2].pan).toBe(-0.5);
    expect(setPatchPath(p, 'master', 0.1)).toBe(true);
    expect(setPatchPath(p, 'voice.mode', 1)).toBe(false);
    expect(setPatchPath(p, 'nothing.here', 1)).toBe(false);
  });
});

describe('chorus / flanger', () => {
  it('has sane defaults and clamps untrusted values', () => {
    expect(defaultParams('chorus')).toMatchObject({ rate: 0.8, mix: 0.5 });
    const s = sanitizeEffect({ type: 'chorus', params: { rate: 99, depth: -1, feedback: 5, width: 2 } });
    expect(s?.params).toMatchObject({ rate: 10, depth: 0, feedback: 0.95, width: 1 });
  });
});
