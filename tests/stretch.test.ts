/**
 * The time-stretcher (phase vocoder with phase locking, stereo-linked phases
 * and transient handling): length, pitch, clicks, level, stereo image and
 * transients, measured. Transient thresholds come from these measurements on
 * drum-like hits (noise + 80 Hz body, decaying, over a quiet pad): the
 * original's attack rises 10 → 90 % in 2.5–3 ms (0.5 ms envelope) with the
 * pad 20 dB under the hit before it; a plain phase vocoder (no locking, no
 * transient handling) smears that to 21–31 ms with a pre-echo only 4–7 dB
 * under the hit; this one keeps 2.5–4 ms at 1.25× / 0.8× (7 ms at 2×) and no
 * pre-echo above the pad. The limits leave ~1.5 ms / 1 dB of headroom.
 */
import { describe, expect, it } from 'vitest';
import { detectOnsets, timeStretch } from '../src/audio/stretch/vocoder';
import { FFT } from '../src/audio/stretch/fft';
import { maxStep } from './clickMetric';

const SR = 48000;
const sine = (f: number, sec: number, a = 0.5, phase = 0) => new Float32Array(Math.round(sec * SR)).map((_, i) => a * Math.sin((2 * Math.PI * f * i) / SR + phase));

/** frequency of the strongest partial (32768-point FFT of the middle, parabolic interpolation) */
function peakFreq(x: Float32Array): number {
  const N = 32768;
  const fft = new FFT(N);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const off = Math.max(0, Math.floor((x.length - N) / 2));
  for (let n = 0; n < N; n++) re[n] = (x[off + n] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N));
  fft.transform(re, im);
  const mag = (k: number) => Math.hypot(re[k]!, im[k]!);
  let best = 1;
  for (let k = 1; k < N / 2; k++) if (mag(k) > mag(best)) best = k;
  const a = Math.log(mag(best - 1));
  const b = Math.log(mag(best));
  const c = Math.log(mag(best + 1));
  return ((best + (0.5 * (a - c)) / (a - 2 * b + c)) * SR) / N;
}

/** drum-like hits every `every` s over a quiet pad; returns the signal and the hit positions */
function hits(seconds: number, every: number): { x: Float32Array; at: number[] } {
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  const at: number[] = [];
  let s = 12345;
  const rnd = () => {
    s = (s * 1103515245 + 12345) >>> 0;
    return (s / 4294967296) * 2 - 1;
  };
  for (let t0 = 0.1; t0 < seconds - 0.3; t0 += every) {
    const i0 = Math.round(t0 * SR);
    at.push(i0);
    for (let i = 0; i < 0.3 * SR; i++) {
      const t = i / SR;
      x[i0 + i] = (x[i0 + i] as number) + 0.6 * Math.exp(-t / 0.03) * rnd() + 0.4 * Math.exp(-t / 0.08) * Math.sin(2 * Math.PI * 80 * t);
    }
  }
  for (let i = 0; i < n; i++) x[i] = (x[i] as number) + 0.05 * Math.sin((2 * Math.PI * 330 * i) / SR);
  return { x, at };
}

/** per hit: energy just before it vs just after it (dB), and the attack's 10 → 90 % rise time (ms) */
function transients(y: Float32Array, at: number[]): { pre: number[]; rise: number[] } {
  const pre: number[] = [];
  const rise: number[] = [];
  const e = (a: number, b: number) => {
    let s = 0;
    for (let i = Math.max(0, a); i < Math.min(y.length, b); i++) s += (y[i] as number) ** 2;
    return s / Math.max(1, b - a);
  };
  for (const o of at) {
    pre.push(10 * Math.log10(e(o - Math.round(0.025 * SR), o - Math.round(0.003 * SR)) / e(o, o + Math.round(0.022 * SR))));
    const step = 24; // 0.5 ms
    const env: number[] = [];
    for (let i = o - 960; i < o + 2400; i += step) {
      let m = 0;
      for (let j = i; j < i + step; j++) m = Math.max(m, Math.abs(y[j] ?? 0));
      env.push(m);
    }
    const pk = Math.max(...env);
    rise.push(((env.findIndex((v) => v > 0.9 * pk) - env.findIndex((v) => v > 0.1 * pk)) * step * 1000) / SR);
  }
  return { pre, rise };
}
const median = (a: number[]) => [...a].sort((p, q) => p - q)[a.length >> 1] as number;

describe('time-stretch', () => {
  it('output length = input length × factor, for mono and stereo; 1× is a copy', () => {
    const x = sine(220, 1.3);
    for (const f of [0.25, 0.8, 1, 1.25, 4]) {
      const [y] = timeStretch([x], SR, f);
      expect(y!.length, `×${f}`).toBe(Math.round(x.length * f));
    }
    expect(timeStretch([x, x], SR, 1.5)).toHaveLength(2);
    expect(timeStretch([x], SR, 1)[0]).toEqual(x);
  });

  it('keeps the pitch: a sine stretched to 0.8× and 1.25× (and the 0.25× / 4× extremes) stays at its frequency', () => {
    for (const f0 of [440, 97.3, 2500]) {
      const x = sine(f0, 2);
      const ref = peakFreq(x);
      for (const f of [0.8, 1.25, 0.25, 4]) {
        const y = timeStretch([x], SR, f)[0]!;
        expect(Math.abs(peakFreq(y) - ref) / ref, `${f0} Hz at ×${f}`).toBeLessThan(5e-4); // < 1 cent
      }
    }
  });

  it('no clicks at grain boundaries, steady level: a stretched sine steps no more than the sine itself', () => {
    // 240 Hz: 200 samples a period, so 400-sample windows hold whole periods (RMS is exact)
    const x = sine(240, 3);
    for (const f of [0.8, 1.25, 0.25, 4]) {
      const y = timeStretch([x, x], SR, f)[0]!;
      const a = Math.round(0.2 * SR);
      const b = y.length - Math.round(0.2 * SR);
      const steadyStep = maxStep(x, 0.1, 2.9);
      expect(maxStep(y, a / SR, b / SR) / steadyStep, `×${f}`).toBeLessThan(1.05);
      const rms: number[] = [];
      for (let s = a; s + 400 <= b; s += 400) {
        let e = 0;
        for (let i = s; i < s + 400; i++) e += (y[i] as number) ** 2;
        rms.push(10 * Math.log10(e / 400));
      }
      expect(Math.max(...rms) - Math.min(...rms), `level wobble ×${f}`).toBeLessThan(0.3);
      expect(Math.abs(median(rms) - 10 * Math.log10(0.125)), `level ×${f}`).toBeLessThan(0.3);
    }
  });

  it('keeps the stereo image: a right channel 90° ahead of the left stays 90° ahead', () => {
    const l = sine(220, 3);
    const r = sine(220, 3, 0.5, Math.PI / 2);
    for (const f of [0.8, 1.25]) {
      const [yl, yr] = timeStretch([l, r], SR, f);
      const q = Math.round(SR / 220 / 4); // a quarter period
      let err = 0;
      let en = 0;
      for (let i = Math.round(0.2 * SR); i < yl!.length - Math.round(0.2 * SR); i++) {
        err += ((yr![i] as number) - (yl![i + q] as number)) ** 2;
        en += (yr![i] as number) ** 2;
      }
      expect(10 * Math.log10(err / en), `×${f}`).toBeLessThan(-30);
    }
  });

  it('finds the onsets of drum hits (and none in a steady tone)', () => {
    const { x, at } = hits(4, 0.4);
    const found = detectOnsets(x, SR);
    expect(found).toHaveLength(at.length);
    found.forEach((o, i) => expect(Math.abs(o - at[i]!)).toBeLessThan(64));
    expect(detectOnsets(sine(330, 2), SR)).toEqual([]);
  });

  it('transients stay sharp: no pre-echo, attacks within 5 ms (a plain phase vocoder: 20–30 ms)', () => {
    const { x, at } = hits(4, 0.4);
    const orig = transients(x, at);
    for (const f of [1.25, 0.8, 2]) {
      const y = timeStretch([x], SR, f)[0]!;
      const t = transients(
        y,
        at.map((o) => Math.round(o * f)),
      );
      // nothing ahead of the hit but the pad (as in the original, within 1 dB)
      expect(Math.max(...t.pre), `pre-echo ×${f}`).toBeLessThan(Math.max(...orig.pre) + 1);
      expect(median(t.rise), `median attack ×${f}`).toBeLessThanOrEqual(median(orig.rise) + 1.5);
      expect(Math.max(...t.rise), `slowest attack ×${f}`).toBeLessThanOrEqual(f >= 2 ? 8.5 : 5);
      // the same through a plain vocoder, to show what the measurement catches
      const plain = transients(timeStretch([x], SR, f, { phaseLock: false, transients: false })[0]!, at.map((o) => Math.round(o * f)));
      expect(median(plain.rise), `plain vocoder ×${f}`).toBeGreaterThan(8);
    }
  });

  it('is deterministic (playback and export get the same samples)', () => {
    const { x } = hits(2, 0.3);
    expect(timeStretch([x, x], SR, 1.37)).toEqual(timeStretch([x, x], SR, 1.37));
  });
});
