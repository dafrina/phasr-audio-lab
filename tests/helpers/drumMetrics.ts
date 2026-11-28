/**
 * Measurements of rendered drum hits (tests/drumQuality.test.ts): transient rise
 * time, band energies, K-weighted loudness, tails and DC.
 */
import { FFT } from '../../src/audio/stretch/fft';
import { BW4, Biquad, Chain } from '../../src/drums/dsp';

export const db = (x: number) => (x > 0 ? 10 * Math.log10(x) : -300);

export function peakOf(x: ArrayLike<number>): number {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i] as number));
  return p;
}

/**
 * The attack: an envelope of x — RMS over 0.25 ms (so one noise spike doesn't count as
 * the hit's level), held for `holdMs` (so a low tone's zero crossings don't count as
 * the envelope dropping); returns when it first reaches 10 % of its maximum over the
 * first `searchMs` (the onset) and how long it then takes to reach 80 % (the rise).
 * Causal throughout: the envelope never leads the signal.
 */
export function attackTimes(x: Float32Array, sr: number, holdMs = 2, searchMs = 30): { onsetMs: number; riseMs: number } {
  const n = Math.min(x.length, Math.round((searchMs / 1000) * sr));
  const w = Math.max(1, Math.round(0.00025 * sr));
  const hold = Math.max(1, Math.round((holdMs / 1000) * sr));
  const rms = new Float64Array(n);
  let e = 0;
  for (let i = 0; i < n; i++) {
    e += (x[i] as number) ** 2 - (i >= w ? (x[i - w] as number) ** 2 : 0);
    rms[i] = Math.sqrt(Math.max(0, e) / w);
  }
  const env = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = Math.max(0, i - hold + 1); j <= i; j++) m = Math.max(m, rms[j] as number);
    env[i] = m;
  }
  const top = peakOf(env);
  let i10 = -1;
  let i80 = -1;
  for (let i = 0; i < n; i++) {
    if (i10 < 0 && (env[i] as number) >= 0.1 * top) i10 = i;
    if (i80 < 0 && (env[i] as number) >= 0.8 * top) i80 = i;
  }
  return { onsetMs: (i10 * 1000) / sr, riseMs: ((i80 - i10) * 1000) / sr };
}

/**
 * How hard a hit starts: the RMS of its first millisecond against its loudest millisecond
 * in the first `searchMs` (dB, ≤ 0). A hit at full level from its first sample is ≈ 0 dB;
 * a 1 ms fade-in costs 4.8 dB (a ramp's RMS is 1/√3 of its top).
 */
export function firstMsDb(x: Float32Array, sr: number, searchMs = 20): number {
  const w = Math.round(sr / 1000);
  const ms = (k: number) => {
    let e = 0;
    for (let i = k * w; i < Math.min(x.length, (k + 1) * w); i++) e += (x[i] as number) ** 2;
    return e;
  };
  let top = 0;
  for (let k = 0; k < searchMs; k++) top = Math.max(top, ms(k));
  return db(ms(0) / top);
}

/**
 * power spectrum of x[from, to) (seconds), zero-padded to a power of two; Hann window,
 * or 4-term Blackman-Harris (sidelobes −92 dB) to see weak lines next to strong ones
 */
export function powerSpectrum(x: Float32Array, sr: number, from = 0, to = x.length / sr, window: 'hann' | 'bh4' = 'hann'): { p: Float64Array; binHz: number } {
  const a = Math.max(0, Math.round(from * sr));
  const b = Math.min(x.length, Math.round(to * sr));
  let size = 1;
  while (size < b - a) size <<= 1;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const m = b - a;
  for (let i = 0; i < m; i++) {
    const u = (2 * Math.PI * (i + 0.5)) / m;
    const w = window === 'hann' ? 0.5 - 0.5 * Math.cos(u) : 0.35875 - 0.48829 * Math.cos(u) + 0.14128 * Math.cos(2 * u) - 0.01168 * Math.cos(3 * u);
    re[i] = (x[a + i] as number) * w;
  }
  new FFT(size).transform(re, im);
  const p = new Float64Array(size / 2);
  for (let k = 0; k < size / 2; k++) p[k] = ((re[k] as number) ** 2 + (im[k] as number) ** 2) / size;
  return { p, binHz: sr / size };
}

/** energy between lo and hi Hz in a power spectrum */
export function bandEnergy(s: { p: Float64Array; binHz: number }, lo: number, hi: number): number {
  let e = 0;
  for (let k = Math.max(0, Math.ceil(lo / s.binHz)); k < Math.min(s.p.length, Math.floor(hi / s.binHz)); k++) e += s.p[k] as number;
  return e;
}

/** spectral centroid (Hz) */
export function centroid(s: { p: Float64Array; binHz: number }): number {
  let num = 0;
  let den = 0;
  for (let k = 0; k < s.p.length; k++) {
    num += k * s.binHz * (s.p[k] as number);
    den += s.p[k] as number;
  }
  return den > 0 ? num / den : 0;
}

/**
 * RMS envelope (dB re the signal's peak) of the part of x between lo and hi Hz (causal
 * 4th-order Butterworth band: nothing smeared ahead of the signal), per `winMs` window
 */
export function bandEnvelope(x: Float32Array, sr: number, lo: number, hi: number, winMs = 10): number[] {
  const band = new Chain([
    ...(lo > 0 ? [Biquad.highpass(lo, BW4[0] as number, sr), Biquad.highpass(lo, BW4[1] as number, sr)] : []),
    ...(hi < sr / 2 ? [Biquad.lowpass(hi, BW4[0] as number, sr), Biquad.lowpass(hi, BW4[1] as number, sr)] : []),
  ]);
  const win = Math.max(1, Math.round((winMs / 1000) * sr));
  const pk = peakOf(x);
  const out: number[] = [];
  let e = 0;
  let k = 0;
  for (let i = 0; i < x.length; i++) {
    e += band.process(x[i] as number) ** 2;
    if (++k === win || i === x.length - 1) {
      out.push(db(e / k / (pk * pk)));
      e = 0;
      k = 0;
    }
  }
  return out;
}

/** BS.1770 K-weighting at 48 kHz */
export function kWeight(x: ArrayLike<number>): Float64Array {
  const sos = [
    [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585],
    [1, -2, 1, -1.99004745483398, 0.99007225036621],
  ] as const;
  let cur = Float64Array.from(x);
  for (const [b0, b1, b2, a1, a2] of sos) {
    const y = new Float64Array(cur.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < cur.length; i++) {
      const v = b0 * (cur[i] as number) + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = cur[i] as number;
      y2 = y1;
      y1 = v;
      y[i] = v;
    }
    cur = y;
  }
  return cur;
}

/**
 * Loudness of one hit (LUFS, mono): its loudest K-weighted 400 ms window (BS.1770's
 * momentary loudness, 10 ms hop), so a long 808 counts its sustain and a swell counts
 * at its loudest.
 */
export function hitLoudness(x: ArrayLike<number>, sr = 48000, winMs = 400): number {
  const k = kWeight(x);
  const win = Math.round((winMs / 1000) * sr);
  const hop = Math.round(0.01 * sr);
  const sq = new Float64Array(k.length + 1);
  for (let i = 0; i < k.length; i++) sq[i + 1] = (sq[i] as number) + (k[i] as number) ** 2;
  let best = 0;
  for (let s = 0; s < Math.max(1, k.length - win + hop); s += hop) best = Math.max(best, (sq[Math.min(k.length, s + win)] as number) - (sq[s] as number));
  return -0.691 + db(best / win);
}

/** BS.1770 integrated loudness of a mono or stereo signal at 48 kHz (gated, 400 ms blocks, 75 % overlap) */
export function integratedLoudness(chans: ArrayLike<number>[]): number {
  const k = chans.map(kWeight);
  const blk = 19200;
  const hop = 4800;
  const z: number[] = [];
  for (let s = 0; s + blk <= (k[0] as Float64Array).length; s += hop) {
    let sum = 0;
    for (const c of k) {
      let e = 0;
      for (let i = s; i < s + blk; i++) e += (c[i] as number) ** 2;
      sum += e / blk;
    }
    z.push(sum);
  }
  const L = (v: number) => -0.691 + db(v);
  const abs = z.filter((v) => L(v) > -70);
  const rel = L(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const gated = abs.filter((v) => L(v) > rel);
  return L(gated.reduce((a, b) => a + b, 0) / gated.length);
}

/** RMS (dB re peak) of the last `ms` of a hit */
export function tailDb(x: Float32Array, sr: number, ms: number): number {
  const n = Math.round((ms / 1000) * sr);
  let e = 0;
  for (let i = x.length - n; i < x.length; i++) e += (x[i] as number) ** 2;
  return db(e / n / peakOf(x) ** 2);
}
