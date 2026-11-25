import { describe, expect, it } from 'vitest';
import {
  audioSourcePosition,
  collectAudioClipStart,
  collectClipNotes,
  computeSegments,
  metronomeTicks,
  segmentTime,
  tickAtTime,
  type Segment,
} from '../src/audio/scheduling';
import { createAudioClip, createMidiClip } from '../src/project/defaults';
import type { MidiClip } from '../src/project/types';

const BPM = 120; // 1 tick = 1/1920 s
const noLoop = { enabled: false, start: 0, end: 3840 };

function clipWithNotes(start: number, length: number, notes: [number, number, number][], loopLength?: number): MidiClip {
  const c = createMidiClip('t1', start, length);
  return {
    ...c,
    loop: loopLength !== undefined,
    loopLength: loopLength ?? length,
    notes: notes.map(([pitch, s, l], i) => ({ id: `n${i}`, pitch, start: s, length: l, velocity: 100 })),
  };
}

describe('computeSegments', () => {
  it('produces one linear segment without a loop', () => {
    const { segments, next } = computeSegments({ tick: 0, time: 1, fresh: true }, 1.1, BPM, noLoop);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.startTick).toBe(0);
    expect(segments[0]?.endTick).toBeCloseTo(192, 6);
    expect(next.tick).toBeCloseTo(192, 6);
    expect(next.time).toBeCloseTo(1.1, 9);
    expect(next.fresh).toBe(false);
  });

  it('wraps at the loop end and marks the new segment fresh', () => {
    const loop = { enabled: true, start: 960, end: 1920 };
    // cursor 100 ticks before loop end; window of 0.1 s = 192 ticks
    const { segments, next } = computeSegments({ tick: 1820, time: 0, fresh: false }, 0.1, BPM, loop);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ startTick: 1820, endTick: 1920, hardEndTick: 1920, fresh: false });
    expect(segments[1]?.startTick).toBe(960);
    expect(segments[1]?.fresh).toBe(true);
    expect(segments[1]?.startTime).toBeCloseTo(100 / 1920, 9);
    expect(next.tick).toBeCloseTo(960 + 92, 6);
  });

  it('handles windows longer than the loop (multiple wraps)', () => {
    const loop = { enabled: true, start: 0, end: 96 }; // 0.05 s loop
    const { segments } = computeSegments({ tick: 0, time: 0, fresh: true }, 0.21, BPM, loop);
    expect(segments.length).toBe(5);
    for (const s of segments.slice(0, 4)) expect(s.endTick).toBe(96);
  });

  it('continues linearly if the cursor is past the loop region', () => {
    const loop = { enabled: true, start: 0, end: 960 };
    const { segments } = computeSegments({ tick: 2000, time: 0, fresh: true }, 0.1, BPM, loop);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.hardEndTick).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('collectClipNotes', () => {
  it('returns notes whose start is inside the segment with absolute ticks', () => {
    const clip = clipWithNotes(3840, 3840, [[60, 0, 480], [62, 960, 480], [64, 1920, 480]]);
    const evs = collectClipNotes(clip, 3840, 3840 + 1000, Infinity);
    expect(evs.map((e) => e.note.pitch)).toEqual([60, 62]);
    expect(evs[0]).toMatchObject({ onTick: 3840, offTick: 4320 });
  });

  it('clamps note ends at clip end and at the loop hard end', () => {
    const clip = clipWithNotes(0, 1000, [[60, 900, 480]]);
    expect(collectClipNotes(clip, 0, 2000, Infinity)[0]?.offTick).toBe(1000);
    const clip2 = clipWithNotes(0, 4000, [[60, 900, 480]]);
    expect(collectClipNotes(clip2, 0, 2000, 1000)[0]?.offTick).toBe(1000);
  });

  it('repeats looping clip content', () => {
    const clip = clipWithNotes(0, 4000, [[60, 0, 100], [67, 500, 100]], 1000);
    const evs = collectClipNotes(clip, 0, 4000, Infinity);
    expect(evs.map((e) => e.onTick)).toEqual([0, 500, 1000, 1500, 2000, 2500, 3000, 3500]);
  });

  it('does not double-schedule across adjacent segments', () => {
    const clip = clipWithNotes(0, 3840, [[60, 0, 100], [61, 480, 100], [62, 960, 100]]);
    const a = collectClipNotes(clip, 0, 480, Infinity);
    const b = collectClipNotes(clip, 480, 960, Infinity);
    const c = collectClipNotes(clip, 960, 1440, Infinity);
    expect([...a, ...b, ...c].map((e) => e.note.pitch)).toEqual([60, 61, 62]);
  });
});

describe('audio clip scheduling', () => {
  const seg = (startTick: number, endTick: number, fresh: boolean, hardEndTick = Infinity): Segment => ({
    startTick,
    endTick,
    startTime: 10,
    fresh,
    hardEndTick,
  });

  it('starts a clip whose start is inside the segment', () => {
    const clip = createAudioClip('t1', 'a1', 'x', 1000, 1920);
    const s = collectAudioClipStart(clip, seg(900, 1100, false), BPM);
    expect(s).toMatchObject({ startTick: 1000, stopTick: 2920, clipOffsetSec: 0 });
  });

  it('starts mid-clip on a fresh segment (play/seek/loop wrap)', () => {
    const clip = createAudioClip('t1', 'a1', 'x', 0, 3840);
    const s = collectAudioClipStart(clip, seg(1920, 2000, true), BPM);
    expect(s?.clipOffsetSec).toBeCloseTo(1, 9);
    expect(collectAudioClipStart(clip, seg(1920, 2000, false), BPM)).toBeNull();
  });

  it('stops at the loop end', () => {
    const clip = createAudioClip('t1', 'a1', 'x', 0, 3840);
    expect(collectAudioClipStart(clip, seg(0, 100, true, 1920), BPM)?.stopTick).toBe(1920);
  });

  it('maps clip offsets to source positions, including loops and trims', () => {
    const clip = { ...createAudioClip('t1', 'a1', 'x', 0, 3840), sourceOffset: 0.5 };
    expect(audioSourcePosition(clip, 0.25)).toBeCloseTo(0.75, 9);
    const looped = { ...clip, loop: true, loopSeconds: 1, loopStartPhase: 0.25 };
    expect(audioSourcePosition(looped, 1.0)).toBeCloseTo(0.75, 9);
  });

  it('computes event times from the segment origin', () => {
    expect(segmentTime(seg(960, 2000, false), 1920, BPM)).toBeCloseTo(10.5, 9);
  });
});

describe('metronome and playhead', () => {
  it('places clicks on beats with bar accents', () => {
    expect(metronomeTicks(900, 4000, 960, 3840)).toEqual([
      { tick: 960, accent: false },
      { tick: 1920, accent: false },
      { tick: 2880, accent: false },
      { tick: 3840, accent: true },
    ]);
  });

  it('maps time to ticks across loop-wrap anchors', () => {
    const anchors = [
      { time: 1, tick: 0 },
      { time: 2, tick: 0 }, // wrapped back to 0 after one second
    ];
    expect(tickAtTime(anchors, 1.5, BPM)).toBeCloseTo(960, 6);
    expect(tickAtTime(anchors, 2.25, BPM)).toBeCloseTo(480, 6);
    // before the first anchor (count-in / start latency) the position holds
    expect(tickAtTime(anchors, 0.5, BPM)).toBe(0);
  });
});
