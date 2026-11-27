import { describe, expect, it } from 'vitest';
import { clipEnvelope, envelopeAt, type ClipPlayback } from '../src/audio/clipEnvelope';

/** a 3 s clip, 1 s fades, level 1 */
const clip = { clipDuration: 3, fadeIn: 1, fadeOut: 1, gain: 1 };
const at = (p: ClipPlayback, ...ts: number[]) => ts.map((t) => +envelopeAt(clipEnvelope(p), t).toFixed(4));

describe('audio clip gain envelope', () => {
  it('played whole: the fades as drawn, silent at both ends', () => {
    const p = { ...clip, when: 10, stopAt: 13, clipOffset: 0 };
    expect(at(p, 10, 10.5, 11, 12, 12.5, 13)).toEqual([0, 0.5, 1, 1, 0.5, 0]);
  });

  it('started inside the fade-in: continues the fade from there after a 4 ms de-click', () => {
    const p = { ...clip, when: 0, stopAt: 2.5, clipOffset: 0.5 };
    const env = clipEnvelope(p);
    expect(env[0]).toEqual({ t: 0, v: 0 });
    expect(at(p, 0.004, 0.1, 0.4, 1)).toEqual([0.504, 0.6, 0.9, 1]);
  });

  it('started inside the fade-out: the clip fades on from its level there', () => {
    const p = { ...clip, when: 0, stopAt: 0.5, clipOffset: 2.5 };
    expect(at(p, 0.1, 0.2, 0.5)).toEqual([0.4, 0.3, 0]);
  });

  it('stopped before the clip ends (loop end): full level until a 4 ms de-click, not the clip fade-out', () => {
    const p = { ...clip, when: 0, stopAt: 1.6, clipOffset: 0 };
    expect(at(p, 1.4, 1.596, 1.598, 1.6)).toEqual([1, 1, 0.5, 0]);
  });

  it('a start at the clip start with no fade still ramps 2 ms (no click)', () => {
    const p = { ...clip, fadeIn: 0, when: 0, stopAt: 3, clipOffset: 0 };
    expect(at(p, 0, 0.001, 0.002, 0.5)).toEqual([0, 0.5, 1, 1]);
  });

  it('overlapping fades meet where the lines cross; the gain scales the whole envelope', () => {
    const p = { clipDuration: 1, fadeIn: 1, fadeOut: 1, gain: 0.5, when: 0, stopAt: 1, clipOffset: 0 };
    expect(at(p, 0.25, 0.5, 0.75)).toEqual([0.125, 0.25, 0.125]);
  });

  it('very short pieces stay inside their window; nothing to play gives no envelope', () => {
    const env = clipEnvelope({ ...clip, when: 0, stopAt: 0.002, clipOffset: 1.5 });
    expect(env.every((e) => e.t >= 0 && e.t <= 0.002)).toBe(true);
    expect(env.at(-1)).toEqual({ t: 0.002, v: 0 });
    expect(clipEnvelope({ ...clip, when: 1, stopAt: 1, clipOffset: 0 })).toEqual([]);
    expect(envelopeAt([], 1)).toBe(0);
  });
});
