import { describe, expect, it } from 'vitest';
import { heardContextTime, MidiTake } from '../src/audio/midiTake';

const BAR = 3840;

describe('MidiTake', () => {
  it('records notes relative to a bar-aligned clip', () => {
    const t = new MidiTake(BAR); // recording starts at bar 2
    t.noteOn(1, 60, 0.8, BAR + 10);
    t.noteOff(1, BAR + 490);
    t.noteOn(2, 64, 1, BAR + 960);
    t.noteOff(2, BAR + 1920);
    const r = t.finish(BAR + 2000, BAR);
    expect(r).not.toBeNull();
    expect(r?.start).toBe(BAR);
    expect(r?.length).toBe(BAR);
    expect(r?.notes.map((n) => [n.pitch, n.start, n.length, n.velocity])).toEqual([
      [60, 10, 480, 102],
      [64, 960, 960, 127],
    ]);
  });

  it('pulls notes played during the count-in to the record start', () => {
    const t = new MidiTake(BAR);
    t.noteOn(1, 60, 0.5, BAR - 200);
    t.noteOff(1, BAR + 480);
    const r = t.finish(BAR + 960, BAR);
    expect(r?.notes[0]?.start).toBe(0);
    expect(r?.notes[0]?.length).toBe(480);
  });

  it('bakes the sustain pedal into note lengths', () => {
    const t = new MidiTake(0);
    t.sustain(true, 0);
    t.noteOn(1, 48, 0.7, 0);
    t.noteOff(1, 240);
    t.noteOn(2, 52, 0.7, 480);
    t.noteOff(2, 720);
    t.sustain(false, 1920);
    t.noteOn(3, 55, 0.7, 2000);
    t.noteOff(3, 2100);
    const r = t.finish(2400, BAR);
    expect(r?.notes.map((n) => [n.pitch, n.start, n.start + n.length])).toEqual([
      [48, 0, 1920],
      [52, 480, 1920],
      [55, 2000, 2100],
    ]);
  });

  it('a re-struck pitch under the pedal ends the ringing note', () => {
    const t = new MidiTake(0);
    t.sustain(true, 0);
    t.noteOn(1, 60, 0.7, 0);
    t.noteOff(1, 100);
    t.noteOn(2, 60, 0.7, 960);
    t.noteOff(2, 1000);
    t.sustain(false, 1500);
    const r = t.finish(1600, BAR);
    expect(r?.notes.map((n) => [n.start, n.length])).toEqual([
      [0, 960],
      [960, 540],
    ]);
  });

  it('closes held notes at the end and enforces a minimum length', () => {
    const t = new MidiTake(0);
    t.noteOn(1, 60, 0.7, 100);
    t.noteOn(2, 62, 0.7, 500);
    t.noteOff(2, 500);
    const r = t.finish(3000, BAR);
    expect(r?.notes.map((n) => [n.pitch, n.length])).toEqual([
      [60, 2900],
      [62, 30],
    ]);
  });

  it('merges loop passes and cuts notes held across the loop end', () => {
    const t = new MidiTake(BAR, { start: BAR, end: 2 * BAR });
    t.noteOn(1, 60, 0.7, BAR + 100);
    t.noteOff(1, BAR + 400);
    t.noteOn(2, 67, 0.7, 2 * BAR - 200);
    t.noteOff(2, BAR + 300); // released after the playhead wrapped
    t.noteOn(3, 64, 0.7, BAR + 960); // second pass
    t.noteOff(3, BAR + 1200);
    const r = t.finish(BAR + 1500, BAR);
    expect(r?.start).toBe(BAR);
    expect(r?.length).toBe(BAR);
    expect(r?.notes.map((n) => [n.pitch, n.start, n.start + n.length])).toEqual([
      [60, 100, 400],
      [64, 960, 1200],
      [67, BAR - 200, BAR],
    ]);
  });

  it('returns null when nothing was played and ignores stray note-offs', () => {
    const t = new MidiTake(0);
    t.noteOff(99, 100);
    expect(t.finish(500, BAR)).toBeNull();
  });

  it('exposes held notes live (end = null) while recording', () => {
    const t = new MidiTake(0);
    t.noteOn(1, 60, 0.7, 10);
    expect(t.live()).toEqual([{ pitch: 60, start: 10, end: null, velocity: 89 }]);
  });
});

describe('heardContextTime', () => {
  it('maps a performance timestamp onto the audible context time', () => {
    // at performance 10 000 ms the speakers play context time 5.000 s
    const t = heardContextTime(10_050, { contextTime: 5, performanceTime: 10_000 }, { currentTime: 0, nowMs: 0 });
    expect(t).toBeCloseTo(5.05, 6);
  });

  it('falls back to currentTime minus reported output latency', () => {
    const t = heardContextTime(1000, null, { currentTime: 3, outputLatency: 0.03, baseLatency: 0.01, nowMs: 1010 });
    expect(t).toBeCloseTo(3 - 0.04 - 0.01, 6);
  });
});
