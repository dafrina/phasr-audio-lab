import { describe, expect, it } from 'vitest';
import { WARP_MAX, WARP_MIN, stretchFactorFor, warpRate } from '../src/audio/warp';
import { audioSourcePosition } from '../src/audio/scheduling';
import { audioAvailableTicks, setClipLoop, splitClip, trimClipEnd, trimClipStart } from '../src/project/clipOps';
import { createAudioClip, createProject, createTrack } from '../src/project/defaults';
import { migrateProject } from '../src/project/migrations';
import type { AudioClip } from '../src/project/types';

const PPQ = 960;
const BPM = 120; // a beat = 0.5 s

/** an audio clip played at 60 BPM, at a 120 BPM project: it plays twice as fast */
const warped = (o: Partial<AudioClip> = {}): AudioClip => ({ ...createAudioClip('t', 'a', 'Loop', 0, 4 * PPQ, 60), ...o });

describe('warp', () => {
  it('rate = project BPM ÷ clip BPM, limited to 0.25×–4×; off = the audio’s own speed', () => {
    expect(warpRate(warped(), 120)).toBe(2);
    expect(warpRate(warped(), 45)).toBe(0.75);
    expect(warpRate(warped({ bpm: 10 }), 120)).toBe(WARP_MAX);
    expect(warpRate(warped({ bpm: 1000 }), 120)).toBe(WARP_MIN);
    expect(warpRate(warped({ warp: false }), 120)).toBe(1);
    expect(stretchFactorFor(2)).toBe(0.5);
    expect(stretchFactorFor(1 / 0.8)).toBe(0.8);
  });

  it('new clips: warp on with the tempo they were made at, if given; off otherwise', () => {
    expect(createAudioClip('t', 'a', 'x', 0, 960, 97)).toMatchObject({ warp: true, bpm: 97 });
    expect(createAudioClip('t', 'a', 'x', 0, 960)).toMatchObject({ warp: false });
  });

  it('a warped clip moves through its source at its rate (also in its loop)', () => {
    expect(audioSourcePosition(warped(), 1, BPM)).toBe(2);
    expect(audioSourcePosition(warped({ sourceOffset: 0.5 }), 0.25, BPM)).toBe(1);
    const loop = warped({ loop: true, loopSeconds: 1.5, loopStartPhase: 0.25 });
    expect(audioSourcePosition(loop, 1, BPM)).toBeCloseTo(0.75, 9); // (0.25 + 2) mod 1.5
    expect(audioSourcePosition(warped({ warp: false }), 1, BPM)).toBe(1);
  });

  it('trims and splits move the source by the source time under the cut (fades stay timeline time)', () => {
    // trimming one beat (0.5 s of timeline) off the start skips 1 s of a 2× clip
    const t = trimClipStart(warped(), PPQ, BPM) as AudioClip;
    expect([t.start, t.length, t.sourceOffset]).toEqual([PPQ, 3 * PPQ, 1]);
    const [l, r] = splitClip(warped({ fadeIn: 0.1, fadeOut: 0.2 }), PPQ, BPM) as [AudioClip, AudioClip];
    expect(r.sourceOffset).toBe(1);
    expect([l.fadeIn, l.fadeOut, r.fadeIn, r.fadeOut]).toEqual([0.1, 0, 0, 0.2]);
    // a 3 s source lasts 1.5 s = 3 beats at 2×
    expect(audioAvailableTicks(warped(), 3, BPM)).toBe(3 * PPQ);
    expect((trimClipEnd(warped(), 8 * PPQ, BPM, 3) as AudioClip).length).toBe(3 * PPQ);
    // looping a 4-beat (2 s timeline) clip loops 4 s of source
    expect((setClipLoop(warped(), true, BPM) as AudioClip).loopSeconds).toBe(4);
    // a looped clip trimmed by a beat: the loop phase moves by 1 s of source
    const lt = trimClipStart(warped({ loop: true, loopSeconds: 4 }), PPQ, BPM) as AudioClip;
    expect(lt.loopStartPhase).toBe(1);
  });

  it('a schema-2 project: audio clips keep playing at their own speed (warp off, the project tempo as theirs)', () => {
    const p = createProject();
    p.bpm = 93;
    const t = createTrack('audio', 0);
    t.id = 'tr';
    const c = { ...createAudioClip('tr', 'asset', 'Old', 0, 960), id: 'c' } as Record<string, unknown>;
    delete c.warp;
    delete c.bpm;
    const raw = JSON.parse(JSON.stringify({ ...p, schemaVersion: 2, tracks: [t], clips: { c }, assets: { asset: { id: 'asset', name: 'a', sampleRate: 48000, channels: 1, durationSec: 1, frames: 48000 } } }));
    const out = migrateProject(raw).clips.c as AudioClip;
    expect([out.warp, out.bpm]).toEqual([false, 93]);
    // a schema-3 project keeps a clip's warp
    const now = migrateProject({ ...raw, schemaVersion: 3, clips: { c: { ...c, warp: true, bpm: 140 } } }).clips.c as AudioClip;
    expect([now.warp, now.bpm]).toEqual([true, 140]);
  });
});

describe('stretching a clip by its edge', () => {
  it('the end edge: the start stays, the same audio fills the new length, warp goes on with the matching tempo', async () => {
    const { stretchAudioClip } = await import('../src/project/clipOps');
    const plain = { ...createAudioClip('t', 'a', 'x', 2 * PPQ, 4 * PPQ), sourceOffset: 0.3 }; // warp off: rate 1
    const r = stretchAudioClip(plain, 'end', 2 * PPQ + 8 * PPQ, BPM);
    expect(r.clip).toMatchObject({ start: 2 * PPQ, length: 8 * PPQ, warp: true, sourceOffset: 0.3 });
    expect(r.rate).toBe(0.5);
    expect(warpRate(r.clip, BPM)).toBe(0.5);
    expect(r.clip.bpm).toBe(240); // twice as long: as if played at 240 BPM
    // the same source span: 4 beats at 1× = 8 beats at 0.5×
    expect(audioSourcePosition(r.clip, ((8 * PPQ) / PPQ) * 0.5, BPM)).toBeCloseTo(audioSourcePosition(plain, ((4 * PPQ) / PPQ) * 0.5, BPM), 9);
  });

  it('the start edge: the end stays; an already warped clip stretches from its own rate', async () => {
    const { stretchAudioClip } = await import('../src/project/clipOps');
    const c = warped({ start: 4 * PPQ }); // 2× at 120 BPM, 4 beats long, ends at beat 8
    const r = stretchAudioClip(c, 'start', 2 * PPQ, BPM); // 6 beats now
    expect([r.clip.start, r.clip.start + r.clip.length]).toEqual([2 * PPQ, 8 * PPQ]);
    expect(r.rate).toBeCloseTo((2 * 4) / 6, 9);
    expect(r.limited).toBe(false);
  });

  it('limited to 0.25×–4×, and never before bar 1', async () => {
    const { stretchAudioClip } = await import('../src/project/clipOps');
    const c = createAudioClip('t', 'a', 'x', PPQ, 4 * PPQ);
    const long = stretchAudioClip(c, 'end', PPQ + 40 * PPQ, BPM);
    expect([long.rate, long.limited, long.clip.length]).toEqual([0.25, true, 16 * PPQ]);
    const short = stretchAudioClip(c, 'end', PPQ + 100, BPM);
    expect([short.rate, short.limited, short.clip.length]).toEqual([4, true, PPQ]);
    const left = stretchAudioClip(c, 'start', -10 * PPQ, BPM);
    expect([left.clip.start, left.clip.length]).toEqual([0, 5 * PPQ]);
  });
});
