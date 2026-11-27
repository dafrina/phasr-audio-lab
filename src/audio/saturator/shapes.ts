/**
 * Saturator transfer curves (pure; used by the audio unit, the display and
 * tests). Each shape maps a driven input x (any size) to an output in
 * −1 … 1. The WaveShaperNode clamps its input to ±1, so the curve is built
 * over x ∈ [−SAT_RANGE, SAT_RANGE] and the drive gain is divided by
 * SAT_RANGE in front of it: drive stays a smooth AudioParam (automatable)
 * and loud input never just hard-clips at the curve's ends.
 */
import type { SaturatorMode } from '../../project/types';

/** largest drive (linear) the curve covers: +36 dB ≈ 63× */
export const SAT_RANGE = 64;
export const SAT_CURVE_POINTS = 32769;

/** tube bias: shifts the curve so the halves clip differently (even harmonics) */
const TUBE_BIAS = 0.35;
const TUBE_OFFSET = Math.tanh(TUBE_BIAS);
/** 1 / tanh′(bias): unity slope through zero, so quiet signals pass clean */
const TUBE_NORM = 1 / (1 - TUBE_OFFSET * TUBE_OFFSET);

export function saturate(mode: SaturatorMode, x: number): number {
  switch (mode) {
    case 'tape':
      // smooth and symmetric: odd harmonics that grow gently
      return Math.tanh(x);
    case 'tube':
      // biased tanh, recentred (smooth, unity slope at zero): the positive half saturates
      // earlier than the negative → even harmonics (warmth); a second tanh keeps it in ±1
      return Math.tanh((Math.tanh(x + TUBE_BIAS) - TUBE_OFFSET) * TUBE_NORM);
    case 'overdrive':
      // arctangent with a little asymmetry: a harder knee and more bite than tape
      return (2 / Math.PI) * Math.atan(1.6 * x + 0.12 * x * x * Math.sign(x) * (x > 0 ? 1 : 0.6));
    case 'hard':
      // digital clip: flat tops, bright and buzzy
      return Math.max(-1, Math.min(1, x));
    case 'fold': {
      // wave folder: past full scale the wave folds back on itself (metallic, synth-like)
      return Math.sin((Math.PI / 2) * x);
    }
    case 'fuzz':
      // high gain, the halves clip at very different points: buzzy, gated, sputtering
      return x > 0 ? Math.tanh(4 * x) : 0.85 * Math.tanh(1.4 * x);
    case 'rectify':
      // full-wave rectifier, softened: the negative half flips up → an octave above, ring-mod grit
      return Math.tanh(1.3 * Math.abs(x));
  }
}

/** The WaveShaper curve for a mode: index i ↔ x = (2i / (N − 1) − 1) · SAT_RANGE. */
export function saturatorCurve(mode: SaturatorMode, points = SAT_CURVE_POINTS): Float32Array<ArrayBuffer> {
  const c = new Float32Array(points);
  for (let i = 0; i < points; i++) c[i] = saturate(mode, ((2 * i) / (points - 1) - 1) * SAT_RANGE);
  return c;
}

/**
 * How much louder the shape makes a sine at this drive (output / input
 * RMS), averaged geometrically over the levels instruments actually hit
 * this effect with (peaks −14, −8 and −2 dBFS: the fader comes after the
 * effects). Auto gain divides by it, so turning the drive adds grit, not
 * volume. (Saturation also compresses: with a lot of drive, quieter passages
 * come up relative to loud ones.)
 */
export function saturatorGain(mode: SaturatorMode, driveDb: number): number {
  const g = Math.pow(10, driveDb / 20);
  const N = 256;
  let logSum = 0;
  for (const amp of GAIN_LEVELS) {
    let si = 0;
    let so = 0;
    for (let i = 0; i < N; i++) {
      const s = amp * Math.sin((2 * Math.PI * i) / N);
      const y = saturate(mode, s * g);
      si += s * s;
      so += y * y;
    }
    logSum += Math.log(Math.sqrt(so / Math.max(1e-12, si)));
  }
  return Math.exp(logSum / GAIN_LEVELS.length);
}
const GAIN_LEVELS = [0.2, 0.4, 0.8];

/** Harmonic levels (1st … n-th) of a sine at this drive, relative to the fundamental (0 dB). */
export function saturatorHarmonics(mode: SaturatorMode, driveDb: number, n = 10, bias = 0): number[] {
  const g = Math.pow(10, driveDb / 20);
  const N = 512;
  const x = new Float64Array(N);
  for (let i = 0; i < N; i++) x[i] = saturate(mode, 0.5 * g * Math.sin((2 * Math.PI * i) / N) + bias);
  // remove DC (asymmetric shapes), then a DFT at the harmonic bins
  let dc = 0;
  for (let i = 0; i < N; i++) dc += x[i] as number;
  dc /= N;
  const mags: number[] = [];
  for (let k = 1; k <= n; k++) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < N; i++) {
      const v = (x[i] as number) - dc;
      re += v * Math.cos((2 * Math.PI * k * i) / N);
      im -= v * Math.sin((2 * Math.PI * k * i) / N);
    }
    mags.push(Math.hypot(re, im));
  }
  const f = mags[0] || 1e-12;
  return mags.map((m) => 20 * Math.log10(Math.max(1e-9, m / f)));
}
