/**
 * "Click-free" claims, measured. A click is a jump between neighbouring
 * samples that the steady signal never makes: for sines, the largest
 * sample-to-sample step is set by their frequency and level, so around an
 * event (a stolen voice, a note start or end) no step may be much larger than
 * the steady signal's largest step before or after it. A hard cut of a tone
 * at 0.5 is a step of up to 0.5 — 10–20× what these signals make.
 */
import { describe, expect, it } from 'vitest';
import { TriOscSynth } from '../src/synth/dsp/TriOscSynth';
import { defaultPatch, sanitizePatch } from '../src/synth/params';

const SR = 48000;
const BLOCK = 128;

/** largest |x[n] − x[n−1]| between two times (seconds) */
export function maxStep(x: Float32Array, from: number, to: number): number {
  let m = 0;
  for (let i = Math.max(1, Math.round(from * SR)); i < Math.min(x.length, Math.round(to * SR)); i++) m = Math.max(m, Math.abs((x[i] as number) - (x[i - 1] as number)));
  return m;
}

/** step around `at` relative to the steady signal just before and after it */
function clickRatio(x: Float32Array, at: number, win = 0.03): number {
  const steady = Math.max(maxStep(x, at - 0.12, at - 0.01), maxStep(x, at + win + 0.05, at + win + 0.2));
  return maxStep(x, at - 0.005, at + win) / steady;
}

function render(s: TriOscSynth, seconds: number, events: [number, () => void][]): Float32Array {
  const n = Math.round(seconds * SR);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  const ev = [...events].sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < n; i += BLOCK) {
    while (ev.length && (ev[0]![0] as number) * SR < i + BLOCK) ev.shift()![1]();
    s.render(l, r, i, Math.min(BLOCK, n - i));
  }
  return l;
}

describe('click-free voice handling (TriOsc, sine patch)', () => {
  const patch = () => {
    const p = defaultPatch();
    p.voice.polyphony = 2;
    p.ampEnv = { attack: 0.004, decay: 0.1, sustain: 0.9, release: 0.4 };
    return sanitizePatch(p);
  };

  it('the metric sees a click: a tone cut off mid-cycle', () => {
    const x = new Float32Array(SR).map((_, i) => (i < SR / 2 + 37 ? 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR) : 0));
    expect(clickRatio(x, 0.5)).toBeGreaterThan(5);
  });

  it('stealing a held voice (polyphony 2, third note) fades it out instead of cutting it', () => {
    const s = new TriOscSynth(SR, patch());
    const x = render(s, 1, [
      [0, () => s.noteOn(1, 57, 0.9)],
      [0.2, () => s.noteOn(2, 64, 0.9)],
      [0.45, () => s.noteOn(3, 69, 0.9)], // steals note 1 while it is held at full level
    ]);
    expect(s.activeVoiceCount()).toBeLessThanOrEqual(2);
    expect(clickRatio(x, 0.45)).toBeLessThan(1.5);
  });

  it('repeated steals in a fast run stay below the click threshold everywhere', () => {
    const s = new TriOscSynth(SR, patch());
    const events: [number, () => void][] = [];
    for (let k = 0; k < 12; k++) events.push([0.1 + k * 0.15, () => s.noteOn(10 + k, 52 + ((k * 5) % 17), 0.9)]);
    const x = render(s, 2.4, events);
    for (let k = 1; k < 12; k++) expect(clickRatio(x, 0.1 + k * 0.15, 0.03), `steal ${k}`).toBeLessThan(1.6);
  });

  it('note start and release are smooth too', () => {
    // sustain at full level, so the attack's peak is the steady level (no decay overshoot)
    const p = patch();
    p.ampEnv.sustain = 1;
    const s = new TriOscSynth(SR, p);
    const x = render(s, 1.4, [
      [0.3, () => s.noteOn(1, 60, 1)],
      [0.8, () => s.noteOff(1)],
    ]);
    // at the start the steady reference is the note itself (silence before it)
    expect(maxStep(x, 0.29, 0.33)).toBeLessThan(1.05 * maxStep(x, 0.45, 0.7));
    expect(clickRatio(x, 0.8)).toBeLessThan(1.05);
  });
});
