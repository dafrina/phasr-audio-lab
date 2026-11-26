import { describe, expect, it } from 'vitest';
import { ARP_PRESETS, defaultArp, defaultStep, expandHeld, inScale, sanitizeArp, snapToScale, stepInScale, stepNotes, type ArpConfig, type HeldNote } from '../src/arp/arp';
import { arpClip, bakeArp, withToolsExpanded } from '../src/arp/expand';
import { createMidiClip, createProject, createTrack } from '../src/project/defaults';
import { INSTRUMENTS } from '../src/instruments/definitions';
import type { MidiClip, Project } from '../src/project/types';

const PPQ = 960;
const S = PPQ / 4; // a 1/16 step
const held = (...p: number[]): HeldNote[] => p.map((pitch, i) => ({ pitch, velocity: 100, order: i }));
const arp = (o: Partial<ArpConfig> = {}): ArpConfig => ({ ...defaultArp(), swing: 0, ...o });
const pitches = (cfg: ArpConfig, h: HeldNote[], n: number) => Array.from({ length: n }, (_, i) => stepNotes(cfg, h, i, i, S)[0]?.pitch);

describe('arpeggiator', () => {
  it('up / down / up-down across octaves; as played keeps the order', () => {
    const h = held(64, 60, 67);
    expect(pitches(arp({ direction: 'up', octaves: 2 }), h, 7)).toEqual([60, 64, 67, 72, 76, 79, 60]);
    expect(pitches(arp({ direction: 'down', octaves: 1 }), h, 4)).toEqual([67, 64, 60, 67]);
    expect(pitches(arp({ direction: 'updown', octaves: 1 }), h, 5)).toEqual([60, 64, 67, 64, 60]);
    expect(pitches(arp({ direction: 'played', octaves: 1 }), h, 3)).toEqual([64, 60, 67]);
  });

  it('gate sets the note length; swing delays every second step', () => {
    const [a] = stepNotes(arp({ gate: 0.5 }), held(60), 0, 0, S);
    expect(a?.length).toBe(S * 0.5);
    const odd = stepNotes(arp({ swing: 0.5 }), held(60), 1, 1, S)[0];
    const even = stepNotes(arp({ swing: 0.5 }), held(60), 2, 2, S)[0];
    expect(odd?.offset).toBeGreaterThan(0);
    expect(even?.offset).toBe(0);
  });
});

describe('step sequencer', () => {
  const seq = (steps: Partial<ReturnType<typeof defaultStep>>[], o: Partial<ArpConfig> = {}): ArpConfig =>
    arp({ mode: 'seq', length: steps.length, gate: 0.5, steps: Array.from({ length: 16 }, (_, i) => ({ ...defaultStep(false), ...(steps[i] ?? {}) })), ...o });

  it('plays the pattern on the held key and moves with it (transpose)', () => {
    const cfg = seq([{ on: true }, { on: true, transpose: 7 }, { on: false }, { on: true, transpose: 12 }]);
    const run = (key: number) => [0, 1, 2, 3].map((s) => stepNotes(cfg, held(key), s, s, S)[0]?.pitch);
    expect(run(36)).toEqual([36, 43, undefined, 48]);
    expect(run(41)).toEqual([41, 48, undefined, 53]);
  });

  it('accent is louder, ratchets roll, slide overlaps the next step, tie joins steps', () => {
    const cfg = seq([{ on: true, accent: true }, { on: true }, { on: true, ratchet: 3 }, { on: true, slide: true }, { on: true }, { on: true, tie: true }, { on: true }, { on: true }]);
    const n = (s: number) => stepNotes(cfg, held(48), s, s, S);
    expect(n(0)[0]!.velocity).toBeGreaterThan(n(1)[0]!.velocity);
    expect(n(2)).toHaveLength(3);
    expect(n(3)[0]!.length).toBeGreaterThan(S);
    expect(n(5)[0]!.length).toBeGreaterThan(S);
    expect(n(6)).toHaveLength(0); // the tied-into step doesn't strike again
  });

  it('a chord held into the sequencer is gated as a chord (trance gate)', () => {
    const cfg = ARP_PRESETS.find((p) => p.presetName === 'Trance Gate 1/16')!;
    expect(stepNotes(cfg, held(60, 64, 67), 0, 0, S).map((x) => x.pitch)).toEqual([60, 64, 67]);
  });

  it('probability is decided per grid position, the same on every playback', () => {
    const cfg = seq([{ on: true, prob: 0.5 }]);
    const a = Array.from({ length: 64 }, (_, s) => stepNotes(cfg, held(60), s, s, S).length);
    const b = Array.from({ length: 64 }, (_, s) => stepNotes(cfg, held(60), s, s, S).length);
    expect(a).toEqual(b);
    const played = a.filter(Boolean).length;
    expect(played).toBeGreaterThan(16);
    expect(played).toBeLessThan(48);
  });
});

describe('clips through the tool', () => {
  const setup = (cfg: ArpConfig) => {
    const p = createProject();
    const t = { ...createTrack('instrument', 0, INSTRUMENTS.keys.createConfig()), arp: cfg };
    const clip: MidiClip = { ...createMidiClip(t.id, PPQ * 4, PPQ * 4), notes: [{ id: 'a', pitch: 60, start: 0, length: PPQ * 2, velocity: 100 }, { id: 'b', pitch: 67, start: 0, length: PPQ * 2, velocity: 100 }] };
    return { p: { ...p, tracks: [t], clips: { [clip.id]: clip } } as Project, clip };
  };

  it('steps are locked to the song grid and stay inside the clip and its held notes', () => {
    const { clip } = setup(arp({ direction: 'up', octaves: 1, rate: 0.25 }));
    const out = arpClip(clip, arp({ direction: 'up', octaves: 1, rate: 0.25 }));
    // two beats held at 1/16 = 8 steps alternating C and G
    expect(out.notes.map((n) => n.pitch)).toEqual([60, 67, 60, 67, 60, 67, 60, 67]);
    expect(out.notes.every((n) => n.start % S === 0 && n.start + n.length <= clip.length)).toBe(true);
  });

  it('playback hears the pattern; bake writes it into the clip and switches the tool off', () => {
    const { p, clip } = setup(arp({ octaves: 1 }));
    expect((withToolsExpanded(p).clips[clip.id] as MidiClip).notes).toHaveLength(8);
    const baked = bakeArp(p, p.tracks[0]!.id);
    expect((baked.clips[clip.id] as MidiClip).notes).toHaveLength(8);
    expect(baked.tracks[0]!.arp?.enabled).toBe(false);
    // and now playback is the baked notes as they are
    expect((withToolsExpanded(baked).clips[clip.id] as MidiClip).notes).toHaveLength(8);
  });

  it('expandHeld covers a range and clips the notes to it', () => {
    const out = expandHeld(arp({ octaves: 1, gate: 1 }), [{ pitch: 60, start: 0, length: PPQ * 4, velocity: 90 }], 0, PPQ, PPQ);
    expect(out).toHaveLength(4);
    expect(out[3]!.start + out[3]!.length).toBeLessThanOrEqual(PPQ);
  });
});

describe('saved settings', () => {
  it('sanitize keeps good values, repairs bad ones; presets are valid', () => {
    expect(sanitizeArp(null)).toBeNull();
    const s = sanitizeArp({ mode: 'seq', octaves: 9, rate: 0.3, gate: 5, steps: [{ on: true, ratchet: 9, transpose: 99 }] })!;
    expect(s).toMatchObject({ mode: 'seq', octaves: 4, rate: 0.25, gate: 1 });
    expect(s.steps).toHaveLength(16);
    expect(s.steps[0]).toMatchObject({ on: true, ratchet: 4, transpose: 24 });
    for (const pr of ARP_PRESETS) expect(sanitizeArp(JSON.parse(JSON.stringify(pr)))).toEqual(pr);
  });
});

describe('melody lane scales', () => {
  it('snaps to the nearest scale note (ties go up) and stays in range', () => {
    expect(snapToScale('chromatic', 6)).toBe(6);
    expect(snapToScale('minor', 4)).toBe(5); // E → F (E♭ and F are equally near: up wins)
    expect(snapToScale('minor', 11)).toBe(12);
    expect(snapToScale('minor', -1)).toBe(0); // the B below: −2 (B♭) and 0 tie, up wins
    expect(snapToScale('penta', 1)).toBe(0);
    expect(snapToScale('major', 24)).toBe(24);
    expect(snapToScale('major', 30)).toBe(24);
    for (let t = -24; t <= 24; t++) expect(inScale('dorian', snapToScale('dorian', t))).toBe(true);
  });
  it('nudges by scale steps', () => {
    expect(stepInScale('minor', 0, 1)).toBe(2);
    expect(stepInScale('minor', 2, 1)).toBe(3);
    expect(stepInScale('penta', 0, -1)).toBe(-2);
    expect(stepInScale('major', 24, 1)).toBe(24);
  });
  it('the scale is kept and sanitized, playback ignores it', () => {
    expect(sanitizeArp({ ...defaultArp(), scale: 'phrygian' })?.scale).toBe('phrygian');
    expect(sanitizeArp({ ...defaultArp(), scale: 'nope' })?.scale).toBe('chromatic');
    expect(sanitizeArp({ ...defaultArp(), scale: undefined })?.scale).toBe('chromatic');
    const held: HeldNote[] = [{ pitch: 60, velocity: 100, order: 1 }];
    const a: ArpConfig = { ...defaultArp(), mode: 'seq' };
    expect(stepNotes({ ...a, scale: 'minor' }, held, 0, 0, 240)).toEqual(stepNotes(a, held, 0, 0, 240));
  });
});
