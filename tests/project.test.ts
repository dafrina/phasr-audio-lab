import { describe, expect, it } from 'vitest';
import { duplicateClip, moveClip, setClipLoop, splitClip, trimClipEnd, trimClipStart } from '../src/project/clipOps';
import { createAudioClip, createMidiClip, createProject } from '../src/project/defaults';
import { audioSourcePosition, collectClipNotes } from '../src/audio/scheduling';
import { ticksToSeconds } from '../src/core/time';
import { migrateProject, ProjectFormatError } from '../src/project/migrations';
import { PROJECT_SCHEMA_VERSION, type AudioClip, type MidiClip } from '../src/project/types';
import { createHistory, pushHistory, redoHistory, undoHistory } from '../src/state/history';
import { FACTORY_PRESETS, makeUserPreset, presetFromJson, presetToJson, PresetFormatError } from '../src/synth/presets';
import { defaultPatch, sanitizePatch } from '../src/synth/params';

const BPM = 120;

describe('clip positioning and trimming', () => {
  it('moves clips and clamps at zero', () => {
    const c = createMidiClip('t1', 1000);
    expect(moveClip(c, 2000.4).start).toBe(2000);
    expect(moveClip(c, -50).start).toBe(0);
    expect(moveClip(c, 10, 't2').trackId).toBe('t2');
  });

  it('trims audio start non-destructively (source offset follows)', () => {
    const c = createAudioClip('t1', 'a', 'x', 1920, 3840); // 2 s long
    const t = trimClipStart(c, 2880, BPM) as AudioClip; // +0.5 s
    expect(t.start).toBe(2880);
    expect(t.length).toBe(2880);
    expect(t.sourceOffset).toBeCloseTo(0.5, 9);
    // extending back before the source start is clamped
    const back = trimClipStart(t, 0, BPM) as AudioClip;
    expect(back.sourceOffset).toBe(0);
    expect(back.start).toBe(1920);
    expect(back.length).toBe(3840);
  });

  it('limits audio trim end to the available source audio', () => {
    const c = createAudioClip('t1', 'a', 'x', 0, 1920);
    const t = trimClipEnd(c, 100000, BPM, 2) as AudioClip; // asset is 2 s = 3840 ticks
    expect(t.length).toBe(3840);
  });

  it('trims MIDI start keeping notes in place on the timeline', () => {
    const c: MidiClip = { ...createMidiClip('t1', 0, 3840), notes: [{ id: 'a', pitch: 60, start: 960, length: 480, velocity: 100 }, { id: 'b', pitch: 62, start: 100, length: 100, velocity: 100 }] };
    const t = trimClipStart(c, 480, BPM) as MidiClip;
    expect(t.start).toBe(480);
    expect(t.notes).toHaveLength(1);
    expect(t.notes[0]?.start).toBe(480);
  });

  // what a looped clip plays on the timeline, by the scheduler's own rules
  const heard = (c: MidiClip, from: number, to: number) => collectClipNotes(c, from, to, Infinity).map((e) => [e.onTick, e.note.pitch, e.offTick]);

  it('trimming the start of a looped MIDI clip keeps every repeat where it was (shorter and longer)', () => {
    // 4 bars long, a 1-bar loop: kick on beat 1, snare on beat 3
    const c: MidiClip = {
      ...createMidiClip('t1', 3840, 4 * 3840),
      loop: true,
      loopLength: 3840,
      notes: [
        { id: 'k', pitch: 36, start: 0, length: 240, velocity: 100 },
        { id: 's', pitch: 38, start: 1920, length: 240, velocity: 100 },
      ],
    };
    const end = c.start + c.length;
    const before = heard(c, 0, end);
    // trimmed half a beat in: everything after the new start plays as before
    const shorter = trimClipStart(c, c.start + 480, BPM) as MidiClip;
    expect([shorter.start, shorter.length, shorter.loopLength]).toEqual([c.start + 480, c.length - 480, 3840]);
    expect(heard(shorter, 0, end)).toEqual(before.filter(([on]) => (on as number) >= c.start + 480));
    // extended half a bar to the left: the pattern continues backwards
    const longer = trimClipStart(c, c.start - 1920, BPM) as MidiClip;
    expect(heard(longer, 0, end)).toEqual([[1920, 38, 2160], ...before]);
    // a note crossing the new loop seam keeps its start and is cut at the seam (no extra hit)
    const tail: MidiClip = { ...c, notes: [{ id: 'p', pitch: 60, start: 3000, length: 600, velocity: 100 }] };
    const t2 = trimClipStart(tail, tail.start + 3200, BPM) as MidiClip;
    expect(heard(t2, 0, end).map(([on, p]) => [on, p])).toEqual(heard(tail, tail.start + 3200, end).map(([on, p]) => [on, p]));
  });

  it('trimming the start of a looped audio clip keeps the loop region and what plays where', () => {
    const c: AudioClip = { ...createAudioClip('t1', 'a', 'x', 3840, 4 * 3840), loop: true, loopSeconds: 2, sourceOffset: 0.5, loopStartPhase: 0 };
    const src = (clip: AudioClip, tick: number) => audioSourcePosition(clip, ticksToSeconds(tick - clip.start, BPM));
    for (const newStart of [3840 + 960, 3840 - 1920 /* left, past the source start */]) {
      const t = trimClipStart(c, newStart, BPM) as AudioClip;
      expect(t.start).toBe(newStart);
      expect([t.sourceOffset, t.loopSeconds]).toEqual([0.5, 2]);
      for (const tick of [Math.max(newStart, 3840), 7000, 9999, 15000]) expect(src(t, tick)).toBeCloseTo(src(c, tick < 3840 ? tick + 3840 * 2 : tick), 9);
    }
  });

  it('splits audio clips with continuous source offsets', () => {
    const c = createAudioClip('t1', 'a', 'x', 0, 3840);
    const res = splitClip(c, 1920, BPM);
    expect(res).not.toBeNull();
    const [l, r] = res as [AudioClip, AudioClip];
    expect(l.length).toBe(1920);
    expect(r.start).toBe(1920);
    expect(r.sourceOffset).toBeCloseTo(1, 9);
    expect(r.id).not.toBe(l.id);
    expect(splitClip(c, 0, BPM)).toBeNull();
  });

  it("splitting an audio clip keeps the fade-in on the left half and the fade-out on the right (no dip at the cut)", () => {
    // 10 s clip with 2 s fades, split at 5 s
    const c: AudioClip = { ...createAudioClip('t1', 'a', 'x', 0, 19200), fadeIn: 2, fadeOut: 2 };
    const [l, r] = splitClip(c, 9600, BPM) as [AudioClip, AudioClip];
    expect([l.fadeIn, l.fadeOut]).toEqual([2, 0]);
    expect([r.fadeIn, r.fadeOut]).toEqual([0, 2]);
    // split inside a fade: the half that holds only the rest of it fades over that rest (no jump to full level)
    const [l2, r2] = splitClip(c, 1920, BPM) as [AudioClip, AudioClip]; // at 1 s, inside the fade-in
    expect([l2.fadeIn, l2.fadeOut, r2.fadeIn, r2.fadeOut]).toEqual([2, 0, 1, 2]);
    const [l3, r3] = splitClip(c, 17280, BPM) as [AudioClip, AudioClip]; // at 9 s, inside the fade-out
    expect([l3.fadeIn, l3.fadeOut, r3.fadeIn, r3.fadeOut]).toEqual([2, 1, 0, 2]);
  });

  it('splits MIDI clips distributing notes', () => {
    const c: MidiClip = {
      ...createMidiClip('t1', 0, 3840),
      notes: [
        { id: 'a', pitch: 60, start: 0, length: 2000, velocity: 100 },
        { id: 'b', pitch: 62, start: 2000, length: 100, velocity: 100 },
      ],
    };
    const [l, r] = splitClip(c, 1920, BPM) as [MidiClip, MidiClip];
    expect(l.notes).toHaveLength(1);
    expect(l.notes[0]?.length).toBe(1920);
    expect(r.notes[0]?.start).toBe(80);
  });

  it('duplicates clips after the original with fresh ids', () => {
    const c: MidiClip = { ...createMidiClip('t1', 0, 3840), notes: [{ id: 'a', pitch: 60, start: 0, length: 10, velocity: 100 }] };
    const d = duplicateClip(c);
    expect(d.start).toBe(3840);
    expect(d.id).not.toBe(c.id);
    expect(d.notes[0]?.id).not.toBe('a');
  });

  it('toggles looping', () => {
    const a = setClipLoop(createAudioClip('t1', 'a', 'x', 0, 3840), true, BPM) as AudioClip;
    expect(a.loop).toBe(true);
    expect(a.loopSeconds).toBeCloseTo(2, 9);
  });
});

describe('undo/redo history', () => {
  it('pushes, undoes and redoes', () => {
    let h = createHistory(1);
    h = pushHistory(h, 2, 'a', null, 0);
    h = pushHistory(h, 3, 'b', null, 10);
    expect(h.present).toBe(3);
    h = undoHistory(h);
    expect(h.present).toBe(2);
    h = undoHistory(h);
    expect(h.present).toBe(1);
    h = undoHistory(h);
    expect(h.present).toBe(1);
    h = redoHistory(h);
    expect(h.present).toBe(2);
    h = pushHistory(h, 9, 'c', null, 20);
    expect(h.future).toHaveLength(0);
  });

  it('coalesces continuous gestures into one step', () => {
    let h = createHistory(0);
    for (let i = 1; i <= 10; i++) h = pushHistory(h, i, 'knob', 'k1', i * 10);
    expect(h.past).toEqual([0]);
    expect(h.present).toBe(10);
    h = pushHistory(h, 11, 'other', 'k2', 200);
    expect(h.past).toEqual([0, 10]);
    // same key after the coalesce window → new step
    h = pushHistory(h, 12, 'other', 'k2', 5000);
    expect(h.past).toEqual([0, 10, 11]);
  });
});

describe('project serialization', () => {
  it('round-trips through JSON and migration', () => {
    const p = createProject('Test');
    const clip: MidiClip = { ...createMidiClip(p.tracks[1]?.id ?? '', 0), notes: [{ id: 'n', pitch: 60, start: 0, length: 480, velocity: 90 }] };
    p.clips[clip.id] = clip;
    const back = migrateProject(JSON.parse(JSON.stringify(p)));
    expect(back).toEqual(p);
    expect(back.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
  });

  it('drops clips pointing at missing tracks and sanitizes bad values', () => {
    const p = createProject();
    const raw = JSON.parse(JSON.stringify(p));
    raw.bpm = 99999;
    raw.clips.x = { ...createMidiClip('nope', 0), id: 'x' };
    raw.tracks[1].instrument.patch.oscs[0].coarse = 500;
    const back = migrateProject(raw);
    expect(back.bpm).toBe(400);
    expect(back.clips.x).toBeUndefined();
    const inst = back.tracks[1]?.instrument;
    expect(inst?.type === 'triosc' && inst.patch.oscs[0].coarse).toBe(24);
  });

  it('rejects newer schema versions and garbage', () => {
    expect(() => migrateProject({ schemaVersion: 999, tracks: [] })).toThrow(ProjectFormatError);
    expect(() => migrateProject('nope')).toThrow(ProjectFormatError);
  });
});

describe('preset serialization', () => {
  it('has the 12 required factory presets', () => {
    expect(FACTORY_PRESETS.map((p) => p.name)).toEqual([
      'Init Sine', 'Sub Bass', 'Deep Bass', 'Detuned Saw', 'Square Lead', 'Soft Pad',
      'Pluck', '808 Bass', 'Retro Game Lead', 'Noise Percussion', 'Ambient Pad', 'Simple Organ',
    ]);
  });

  it('round-trips presets through JSON', () => {
    for (const p of FACTORY_PRESETS) {
      const back = presetFromJson(presetToJson(p));
      expect(back.patch).toEqual(p.patch);
      expect(back.name).toBe(p.name);
    }
    const user = makeUserPreset('Mine', defaultPatch());
    expect(presetFromJson(JSON.parse(presetToJson(user))).patch).toEqual(user.patch);
  });

  it('rejects invalid presets and fills missing fields', () => {
    expect(() => presetFromJson('{')).toThrow(PresetFormatError);
    expect(() => presetFromJson({ format: 'other' })).toThrow(PresetFormatError);
    const partial = presetFromJson({ format: 'triosc-preset', version: 1, name: 'P', patch: { master: 0.3 } });
    expect(partial.patch.master).toBe(0.3);
    expect(partial.patch.oscs).toHaveLength(3);
    expect(sanitizePatch(undefined)).toEqual(defaultPatch());
  });
});

describe('preset/init consistency', () => {
  it('Init Sine preset equals the init patch, so Init is not shown as edited', () => {
    expect(FACTORY_PRESETS[0]?.patch).toEqual(defaultPatch());
  });
  it('Ambient Pad uses osc 3 as an active AM source', () => {
    const p = FACTORY_PRESETS.find((x) => x.name === 'Ambient Pad')?.patch;
    expect(p?.amMode).toBe(true);
    expect(p?.oscs[2].enabled).toBe(true);
  });
});

describe('loading damaged or hand-edited projects', () => {
  it('repairs or drops invalid clips, notes, assets, loop region and time signature (nothing that would crash playback)', () => {
    const base = createProject();
    const [audio, inst] = base.tracks;
    if (!audio || !inst) throw new Error();
    const good = { id: 'ok', kind: 'midi', trackId: inst.id, name: 'ok', start: 0, length: 3840, loopLength: 3840, loop: false, notes: [{ id: 'n', pitch: 60, start: 0, length: 240, velocity: 100 }] };
    const raw = JSON.parse(JSON.stringify({
      ...base,
      timeSignature: { numerator: 3.5, denominator: 4 },
      loop: { enabled: true, start: 20000, end: 100 },
      assets: { a1: null, a2: { id: 'a2', name: 'kick.wav', sampleRate: 48000, channels: 1, durationSec: 1, frames: 48000 }, a3: 'x' },
      clips: {
        ok: good,
        noNotes: { id: 'noNotes', kind: 'midi', trackId: inst.id, name: 'x', start: 0, length: 3840, loopLength: 3840, loop: false },
        junk: { id: 'junk', kind: 'midi', trackId: inst.id, name: 7, start: 'abc', length: -500, loopLength: 'x', loop: 'yes', notes: [null, { pitch: 999, start: -5, length: 0, velocity: 0 }, { pitch: 'C4' }] },
        midiOnAudio: { ...good, id: 'midiOnAudio', trackId: audio.id },
        audioOnInst: { id: 'audioOnInst', kind: 'audio', trackId: inst.id, name: 'a', start: 0, length: 3840, assetId: 'a2', sourceOffset: 0, gain: 1, loop: false, loopSeconds: 0, loopStartPhase: 0, fadeIn: 0, fadeOut: 0 },
        loud: { id: 'loud', kind: 'audio', trackId: audio.id, name: 'a', start: 0, length: 3840, assetId: 'a2', sourceOffset: -3, gain: 1e9, loop: true, loopSeconds: -1, loopStartPhase: 99, fadeIn: -1, fadeOut: 'z' },
        noAsset: { id: 'noAsset', kind: 'audio', trackId: audio.id, name: 'a', start: 0, length: 3840, assetId: 42, sourceOffset: 0, gain: 1, loop: false, loopSeconds: 0, loopStartPhase: 0, fadeIn: 0, fadeOut: 0 },
      },
    }));
    const p = migrateProject(raw);
    expect(p.timeSignature.numerator).toBe(4);
    expect([p.loop.start, p.loop.end]).toEqual([100, 20000]);
    expect(Object.keys(p.assets)).toEqual(['a2']);
    expect(Object.keys(p.clips).sort()).toEqual(['junk', 'loud', 'noNotes', 'ok']);
    expect(p.clips.ok).toEqual(good);
    const nn = p.clips.noNotes as MidiClip;
    expect(nn.notes).toEqual([]);
    const j = p.clips.junk as MidiClip;
    expect([j.name, j.start, j.length, j.loopLength, j.loop]).toEqual(['Clip', 0, 60, 60, false]);
    expect(j.notes.map((x) => [x.pitch, x.start, x.length, x.velocity])).toEqual([[127, 0, 1, 1]]);
    const a = p.clips.loud as AudioClip;
    expect([a.sourceOffset, a.gain, a.loop, a.loopSeconds, a.loopStartPhase, a.fadeIn, a.fadeOut]).toEqual([0, 2, false, 0, 0, 0, 0]);
    // and the scheduler takes every clip without throwing
    for (const c of Object.values(p.clips)) if (c.kind === 'midi') expect(() => collectClipNotes(c, 0, 1e6, Infinity)).not.toThrow();
  });
});
