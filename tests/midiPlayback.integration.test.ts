/**
 * Integration: project → scheduler (planWindow, real lookahead passes) →
 * TriOscCore (the same DSP the worklet runs) → rendered samples.
 * Verifies MIDI clips play at the right time and pitch, stay in sync with
 * audio clips, loop correctly, and never leave stuck notes after a cancel.
 */
import { describe, expect, it } from 'vitest';
import { planWindow, type Cursor, type PlanContext, type WindowPlan } from '../src/audio/scheduling';
import { ticksPerBar, ticksPerBeatUnit } from '../src/core/time';
import { createAudioClip, createMidiClip, createProject } from '../src/project/defaults';
import { createNote } from '../src/project/noteOps';
import type { MidiClip, Project } from '../src/project/types';
import { TriOscCore } from '../src/synth/dsp/TriOscCore';
import { defaultPatch, sanitizePatch } from '../src/synth/params';
import { parseMidi } from '../src/audio/webmidi';
import { migrateProject } from '../src/project/migrations';

const SR = 48000;
const BLOCK = 128;
const INTERVAL = 0.025;
const LOOKAHEAD = 0.15;

function ctxOf(p: Project): PlanContext {
  return {
    bpm: p.bpm,
    loop: p.loop,
    beatTicks: ticksPerBeatUnit(p.timeSignature),
    barTicks: ticksPerBar(p.timeSignature),
    metronome: p.metronome,
    tracks: p.tracks,
    clips: Object.values(p.clips),
  };
}

interface SimResult {
  l: Float32Array;
  plans: WindowPlan[];
  noteOns: number;
  core: TriOscCore;
}

/**
 * Simulate the realtime transport: every INTERVAL seconds of audio time, plan
 * the lookahead window and hand events to the synth, then render audio up to
 * the next wake-up. `onPass` can mutate the project mid-playback.
 */
function simulate(project: Project, seconds: number, opts: { startTick?: number; onPass?: (t: number) => Project | null } = {}): SimResult {
  const inst = project.tracks.find((t) => t.kind === 'instrument');
  if (inst?.instrument?.type !== 'triosc') throw new Error('no instrument');
  const core = new TriOscCore(SR, inst.instrument.patch);
  const frames = Math.round(seconds * SR);
  const l = new Float32Array(frames);
  const bl = new Float32Array(BLOCK);
  const br = new Float32Array(BLOCK);
  let cursor: Cursor = { tick: opts.startTick ?? 0, time: 0.01, fresh: true };
  let frame = 0;
  let nextId = 1;
  let noteOns = 0;
  let p = project;
  const plans: WindowPlan[] = [];
  while (frame < frames) {
    const now = frame / SR;
    const changed = opts.onPass?.(now);
    if (changed) {
      // edit during playback: cancel the future and restart from the current tick
      p = changed;
      const resume = now + 0.02;
      const tickNow = plans.length ? cursorTickAt(plans, resume, p.bpm) : cursor.tick;
      core.handleMessage({ type: 'cancel', time: resume });
      cursor = { tick: tickNow, time: resume, fresh: true };
    }
    const plan = planWindow(ctxOf(p), cursor, now + LOOKAHEAD);
    plans.push(plan);
    const events = plan.notes.flatMap((n) => {
      const id = nextId++;
      noteOns++;
      return [
        { type: 'noteOn' as const, time: n.onTime, id, note: n.pitch, velocity: n.velocity },
        { type: 'noteOff' as const, time: n.offTime, id },
      ];
    });
    core.handleMessage({ type: 'events', events });
    cursor = plan.next;
    const until = Math.min(frames, Math.round((now + INTERVAL) * SR));
    while (frame < until) {
      core.process(frame, bl, br);
      const n = Math.min(BLOCK, frames - frame);
      l.set(bl.subarray(0, n), frame);
      frame += BLOCK;
    }
  }
  return { l, plans, noteOns, core };
}

/** Musical position at `time` derived from the planned segments (like the transport's anchors). */
function cursorTickAt(plans: WindowPlan[], time: number, bpm: number): number {
  let best: { startTime: number; startTick: number } | null = null;
  for (const pl of plans) for (const s of pl.segments) if (s.startTime <= time && (!best || s.startTime >= best.startTime)) best = s;
  if (!best) return 0;
  return best.startTick + ((time - best.startTime) * bpm * 960) / 60;
}

function firstOnset(a: Float32Array, from = 0, threshold = 1e-3): number {
  for (let i = from; i < a.length; i++) if (Math.abs(a[i] as number) > threshold) return i;
  return -1;
}

function freqAt(a: Float32Array, from: number, to: number): number {
  let first = -1;
  let last = -1;
  let count = 0;
  for (let i = from + 1; i < to; i++) {
    if ((a[i - 1] as number) <= 0 && (a[i] as number) > 0) {
      if (first < 0) first = i;
      last = i;
      count++;
    }
  }
  return ((count - 1) * SR) / (last - first);
}

function rms(a: Float32Array, from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += (a[i] as number) ** 2;
  return Math.sqrt(s / Math.max(1, to - from));
}

function projectWithClip(notes: [number, number, number][], clipStart = 3840): { p: Project; clip: MidiClip } {
  const p = createProject('Integration');
  const inst = p.tracks.find((t) => t.kind === 'instrument');
  if (inst?.instrument?.type !== 'triosc') throw new Error('no inst');
  inst.instrument.patch = sanitizePatch({ ...defaultPatch(), ampEnv: { attack: 0.001, decay: 0.1, sustain: 1, release: 0.01 } });
  const clip: MidiClip = {
    ...createMidiClip(inst.id, clipStart, 3840),
    notes: notes.map(([pitch, start, length]) => createNote(pitch, start, length, 127)),
  };
  p.clips[clip.id] = clip;
  return { p, clip };
}

describe('MIDI clip playback through scheduler + synth', () => {
  it('plays notes at the correct time (sample-accurate) and pitch', () => {
    // bar 2 at 120 BPM starts 2.0 s after the transport start (t0 = 0.01 s)
    const { p } = projectWithClip([[69, 0, 960], [57, 1920, 960]]);
    const { l } = simulate(p, 3.6);
    const expected = Math.round((0.01 + 2.0) * SR);
    // exactly silent up to the scheduled frame, sounding right after it
    expect(firstOnset(l, 0, 0)).toBeGreaterThanOrEqual(expected);
    expect(firstOnset(l, 0, 0)).toBeLessThanOrEqual(expected + 1);
    expect(freqAt(l, expected + 480, expected + 0.45 * SR)).toBeCloseTo(440, 0);
    const second = Math.round((0.01 + 3.0) * SR);
    expect(rms(l, second - 4800, second - 1200)).toBeLessThan(1e-4); // gap between the notes
    expect(freqAt(l, second + 480, second + 0.45 * SR)).toBeCloseTo(220, 0);
  });

  it('schedules each note exactly once across many lookahead windows', () => {
    const notes: [number, number, number][] = Array.from({ length: 16 }, (_, i) => [60 + (i % 12), i * 240, 200]);
    const { p } = projectWithClip(notes);
    const { noteOns, core } = simulate(p, 4.5);
    expect(noteOns).toBe(16);
    expect(core.synth.activeVoiceCount()).toBe(0);
  });

  it('starts MIDI notes and audio clips on the same sample when they share a tick', () => {
    const { p, clip } = projectWithClip([[60, 0, 480]]);
    const audioTrack = p.tracks.find((t) => t.kind === 'audio');
    if (!audioTrack) throw new Error('no audio track');
    const a = createAudioClip(audioTrack.id, 'asset', 'loop', clip.start, 3840);
    p.clips[a.id] = a;
    const { plans } = simulate(p, 2.5);
    const note = plans.flatMap((x) => x.notes)[0];
    const audio = plans.flatMap((x) => x.audio)[0];
    expect(note && audio).toBeTruthy();
    expect(Math.round((note?.onTime ?? 0) * SR)).toBe(Math.round((audio?.when ?? 1) * SR));
  });

  it('repeats notes every loop cycle with the loop region enabled', () => {
    const { p } = projectWithClip([[69, 0, 480]], 0);
    p.loop = { enabled: true, start: 0, end: 1920 }; // 1 s loop
    const { l, noteOns } = simulate(p, 3.2);
    expect(noteOns).toBe(4); // at 0.01, 1.01, 2.01, 3.01 s
    for (const t of [0.01, 1.01, 2.01, 3.01]) {
      const at = Math.round(t * SR);
      expect(rms(l, at + 100, at + 2000)).toBeGreaterThan(0.05);
      if (at > 2000) expect(rms(l, at - 2000, at - 600)).toBeLessThan(1e-3);
    }
  });

  it('editing a clip during playback reschedules without stuck or duplicated notes', () => {
    const { p, clip } = projectWithClip([[60, 0, 3840]], 0); // one long note, whole bar
    let edited = false;
    const res = simulate(p, 3, {
      onPass: (t) => {
        if (edited || t < 0.5) return null;
        edited = true;
        // shorten the note and add another later one while the first is sounding
        const c: MidiClip = { ...clip, notes: [createNote(60, 0, 960, 127), createNote(64, 2400, 480, 127)] };
        return { ...p, clips: { [c.id]: c } };
      },
    });
    // the original long note was released at the edit; the new late note sounds once
    // original long note + the newly added late note; the shortened first note had already started, so it isn't re-triggered
    expect(res.noteOns).toBe(2);
    expect(res.core.synth.activeVoiceCount()).toBe(0);
  });

  it('respects MIDI clip looping inside the clip (content repeats)', () => {
    const { p, clip } = projectWithClip([[69, 0, 240]], 0);
    const looped: MidiClip = { ...clip, length: 3840, loopLength: 960, loop: true };
    p.clips[clip.id] = looped;
    const { noteOns } = simulate(p, 2.2);
    expect(noteOns).toBe(4);
  });

  it('a project with MIDI notes survives JSON round trip and plays identically', () => {
    const { p } = projectWithClip([[69, 0, 960], [72, 960, 960]]);
    const a = simulate(p, 3.2).l;
    const b = simulate(migrateProject(JSON.parse(JSON.stringify(p))), 3.2).l;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs((a[i] as number) - (b[i] as number)));
    expect(diff).toBe(0);
  });
});

describe('Web MIDI parsing', () => {
  it('parses note, sustain, bend and all-notes-off messages', () => {
    expect(parseMidi([0x90, 60, 100])).toEqual({ type: 'noteOn', channel: 0, note: 60, velocity: 100 / 127 });
    expect(parseMidi([0x91, 60, 0])).toEqual({ type: 'noteOff', channel: 1, note: 60 });
    expect(parseMidi([0x80, 61, 30])).toEqual({ type: 'noteOff', channel: 0, note: 61 });
    expect(parseMidi([0xb0, 64, 127])).toEqual({ type: 'sustain', channel: 0, on: true });
    expect(parseMidi([0xb0, 64, 0])).toEqual({ type: 'sustain', channel: 0, on: false });
    expect(parseMidi([0xb0, 123, 0])).toEqual({ type: 'allNotesOff', channel: 0 });
    expect(parseMidi([0xe0, 0, 64])).toEqual({ type: 'bend', channel: 0, value: 0 });
    expect(parseMidi([0xe0, 127, 127])).toMatchObject({ type: 'bend', value: 1 });
    expect((parseMidi([0xe0, 0, 0]) as { value: number }).value).toBe(-1);
    expect(parseMidi([0xf8])).toBeNull();
  });
});
