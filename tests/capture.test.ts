import { describe, expect, it } from 'vitest';
import { CaptureBuffer, buildCapture, freeBarFrom, type CaptureOptions } from '../src/audio/capture';

const PPQ = 960;
const BAR = PPQ * 4;
/** 120 BPM, 4/4: a bar is 2 s, a beat 500 ms */
const opts = (o: Partial<CaptureOptions> = {}): CaptureOptions => ({ nowMs: 100_000, bars: 1, bpm: 120, barTicks: BAR, ppq: PPQ, nowTick: null, loop: null, ...o });
const NaNTick = Number.NaN;

describe('capture buffer (bounded ring per track)', () => {
  it('keeps at most `capacity` events per track, the newest, oldest first', () => {
    const b = new CaptureBuffer(8, 60);
    for (let i = 0; i < 20; i++) b.noteOn('t', i, 60, 0.5, 1000 + i, NaNTick);
    expect(b.size('t')).toBe(8);
    const ev = b.events('t', 2000);
    expect(ev.map((e) => e.at)).toEqual([1012, 1013, 1014, 1015, 1016, 1017, 1018, 1019]);
  });

  it('forgets what is older than its time span; tracks are separate; a deleted track is dropped', () => {
    const b = new CaptureBuffer(64, 60);
    b.noteOn('a', 1, 60, 0.5, 0, NaNTick);
    b.noteOn('a', 2, 62, 0.5, 50_000, NaNTick);
    b.noteOn('b', 3, 64, 0.5, 55_000, NaNTick);
    expect(b.events('a', 70_000).map((e) => e.at)).toEqual([50_000]);
    expect(b.events('b', 70_000)).toHaveLength(1);
    expect(b.lastTrackId).toBe('b');
    b.drop('b');
    expect(b.events('b', 70_000)).toEqual([]);
    expect(b.lastTrackId).toBeNull();
  });

  it('stores velocity 1..127 and the tick (NaN while stopped)', () => {
    const b = new CaptureBuffer();
    b.noteOn('t', 7, 60, 1, 10, 480);
    b.noteOn('t', 8, 61, 0, 11, NaNTick);
    const [x, y] = b.events('t', 20);
    expect(x).toMatchObject({ kind: 'on', pitch: 60, velocity: 127, tick: 480 });
    expect(y).toMatchObject({ kind: 'on', velocity: 1 });
    expect(Number.isNaN(y!.tick)).toBe(true);
  });
});

/** helper: a phrase of notes played with the transport stopped, [ms, pitch, lengthMs] */
function playStopped(b: CaptureBuffer, notes: [number, number, number][]): void {
  notes.forEach(([at, pitch, len], i) => {
    b.noteOn('t', i + 1, pitch, 0.8, at, NaNTick);
    b.noteOff('t', i + 1, at + len, NaNTick);
  });
}

describe('building a capture', () => {
  it('stopped: the last bar before the last note, timing kept from the first note in it', () => {
    const b = new CaptureBuffer();
    // three notes long ago, then a phrase: 4 notes 250 ms apart
    playStopped(b, [
      [90_000, 48, 100],
      [91_000, 50, 100],
      [92_000, 52, 100],
      [97_000, 60, 200],
      [97_250, 62, 200],
      [97_500, 64, 200],
      [97_750, 65, 200],
    ]);
    const r = buildCapture(b.events('t', 100_000), opts())!;
    expect(r.mode).toBe('relative');
    expect(r.start).toBe(0);
    expect(r.length).toBe(BAR);
    // 250 ms = an eighth at 120 BPM; 200 ms = 384 ticks
    expect(r.notes.map((n) => [n.pitch, n.start, n.length])).toEqual([
      [60, 0, 384],
      [62, 480, 384],
      [64, 960, 384],
      [65, 1440, 384],
    ]);
    // extend back bar by bar: three bars (6 s before the last note's end, 97.95 s) reach the note at 92 s
    const r3 = buildCapture(b.events('t', 100_000), opts({ bars: 3 }))!;
    expect(r3.notes.map((n) => n.pitch)).toEqual([52, 60, 62, 64, 65]);
    expect(r3.notes[0]!.start).toBe(0);
    expect(r3.notes[1]!.start).toBe(Math.round((5 / 60) * 120 * PPQ)); // 5 s after the first
    // four bars: every note
    expect(buildCapture(b.events('t', 100_000), opts({ bars: 4 }))!.notes.map((n) => n.pitch)).toEqual([48, 50, 52, 60, 62, 64, 65]);
  });

  it('playing: the notes go where they were heard', () => {
    const b = new CaptureBuffer();
    // bar 5 (tick 4·BAR): a note on each beat
    [0, 1, 2, 3].forEach((beat) => {
      const tick = 4 * BAR + beat * PPQ;
      const at = 50_000 + beat * 500;
      b.noteOn('t', beat + 1, 60 + beat, 0.8, at, tick);
      b.noteOff('t', beat + 1, at + 250, tick + 480);
    });
    const r = buildCapture(b.events('t', 60_000), opts({ nowMs: 60_000 }))!;
    expect(r.mode).toBe('timeline');
    expect(r.start).toBe(4 * BAR);
    expect(r.length).toBe(BAR);
    expect(r.notes.map((n) => [n.pitch, n.start, n.length])).toEqual([
      [60, 0, 480],
      [61, 960, 480],
      [62, 1920, 480],
      [63, 2880, 480],
    ]);
  });

  it('playing with the loop on: passes are merged into one pass of the loop', () => {
    const b = new CaptureBuffer();
    const loop = { start: 0, end: 2 * BAR };
    // pass 1: beats 1 and 3 of bar 1; pass 2 (ticks wrapped): beat 2 of bar 2
    b.noteOn('t', 1, 60, 0.8, 10_000, 0);
    b.noteOff('t', 1, 10_200, 384);
    b.noteOn('t', 2, 64, 0.8, 11_000, 2 * PPQ);
    b.noteOff('t', 2, 11_200, 2 * PPQ + 384);
    b.noteOn('t', 3, 67, 0.8, 14_500, BAR + PPQ);
    b.noteOff('t', 3, 14_700, BAR + PPQ + 384);
    const r = buildCapture(b.events('t', 15_000), opts({ nowMs: 15_000, bars: 4, loop }))!;
    expect(r.mode).toBe('timeline');
    expect([r.start, r.length]).toEqual([0, 2 * BAR]);
    expect(r.notes.map((n) => [n.pitch, n.start])).toEqual([
      [60, 0],
      [64, 2 * PPQ],
      [67, BAR + PPQ],
    ]);
    // a note held across the loop end is cut at the loop end
    const c = new CaptureBuffer();
    c.noteOn('t', 1, 60, 0.8, 1000, 2 * BAR - PPQ);
    c.noteOff('t', 1, 2000, PPQ);
    const rc = buildCapture(c.events('t', 2000), opts({ nowMs: 2000, loop }))!;
    expect(rc.notes.map((n) => [n.start, n.length])).toEqual([[2 * BAR - PPQ - rc.start, PPQ]]);
  });

  it('held notes: a key still down ends now (at the heard tick when playing); notes struck before the window are left out', () => {
    const b = new CaptureBuffer();
    b.noteOn('t', 1, 40, 0.8, 1_000, NaNTick); // long before, still held: left out (struck before the window)
    b.noteOn('t', 2, 60, 0.8, 9_500, NaNTick); // still held
    const r = buildCapture(b.events('t', 10_000), opts({ nowMs: 10_000 }))!;
    expect(r.held).toBe(2);
    expect(r.notes.map((n) => [n.pitch, n.start, n.length])).toEqual([[60, 0, 960]]); // 500 ms
    // playing: it ends at the tick heard now
    const p = new CaptureBuffer();
    p.noteOn('t', 1, 60, 0.8, 9_500, 3 * BAR);
    const rp = buildCapture(p.events('t', 10_000), opts({ nowMs: 10_000, nowTick: 3 * BAR + 960 }))!;
    expect(rp.notes.map((n) => [n.start, n.length])).toEqual([[0, 960]]);
    expect(rp.start).toBe(3 * BAR);
  });

  it('sustain: keys let go under the pedal ring until it comes up — also with the pedal pressed before the window', () => {
    const b = new CaptureBuffer();
    b.sustain('t', true, 5_000, NaNTick); // pedal down long before
    b.noteOn('t', 1, 60, 0.8, 9_000, NaNTick);
    b.noteOff('t', 1, 9_100, NaNTick);
    b.noteOn('t', 2, 64, 0.8, 9_250, NaNTick);
    b.noteOff('t', 2, 9_300, NaNTick);
    b.sustain('t', false, 9_750, NaNTick);
    const r = buildCapture(b.events('t', 10_000), opts({ nowMs: 10_000 }))!;
    expect(r.notes.map((n) => [n.pitch, n.start, n.start + n.length])).toEqual([
      [60, 0, 1440],
      [64, 480, 1440],
    ]);
  });

  it('any note played while stopped makes the whole capture relative; nothing played → null', () => {
    const b = new CaptureBuffer();
    b.noteOn('t', 1, 60, 0.8, 9_000, 2 * BAR);
    b.noteOff('t', 1, 9_100, 2 * BAR + 100);
    b.noteOn('t', 2, 62, 0.8, 9_500, NaNTick);
    b.noteOff('t', 2, 9_600, NaNTick);
    expect(buildCapture(b.events('t', 10_000), opts({ nowMs: 10_000 }))!.mode).toBe('relative');
    expect(buildCapture([], opts())).toBeNull();
    const offs = new CaptureBuffer();
    offs.sustain('t', true, 1, NaNTick);
    expect(buildCapture(offs.events('t', 10), opts({ nowMs: 10 }))).toBeNull();
  });
});

describe('where a relative capture goes', () => {
  it('the playhead bar if free, else the first bar after the clips in the way', () => {
    const clips = [
      { start: 0, length: 2 * BAR },
      { start: 2 * BAR, length: BAR + 100 },
      { start: 6 * BAR, length: BAR },
    ];
    expect(freeBarFrom(clips, 4 * BAR + 500, BAR, BAR)).toBe(4 * BAR);
    expect(freeBarFrom(clips, BAR, BAR, BAR)).toBe(4 * BAR); // after the clip ending in bar 4
    expect(freeBarFrom(clips, 5 * BAR, 2 * BAR, BAR)).toBe(7 * BAR); // two bars don't fit before bar 7
    expect(freeBarFrom([], 3 * BAR + 10, BAR, BAR)).toBe(3 * BAR);
  });
});
