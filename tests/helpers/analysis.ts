/** Offline rendering and spectral measurement helpers for instrument tests. */
import { KeysSynth } from '../../src/keys/dsp/KeysSynth';
import type { KeysConfigData } from '../../src/keys/params';

export interface ScoreEvent {
  t: number;
  type: 'on' | 'off' | 'sustain' | 'param';
  id?: number;
  note?: number;
  vel?: number;
  on?: boolean;
  key?: string;
  value?: number;
}

/** Render a score through KeysSynth; returns [left, right]. */
export function renderKeys(config: KeysConfigData, score: ScoreEvent[], seconds: number, sr = 48000, synth?: KeysSynth): [Float32Array, Float32Array] {
  const s = synth ?? new KeysSynth(sr, config);
  const total = Math.round(seconds * sr);
  const L = new Float32Array(total);
  const R = new Float32Array(total);
  const evs = [...score].sort((a, b) => a.t - b.t);
  let pos = 0;
  let e = 0;
  while (pos < total) {
    const next = e < evs.length ? Math.min(total, Math.round((evs[e] as ScoreEvent).t * sr)) : total;
    if (next > pos) {
      s.render(L, R, pos, next - pos);
      pos = next;
    }
    while (e < evs.length && Math.round((evs[e] as ScoreEvent).t * sr) <= pos) {
      const ev = evs[e++] as ScoreEvent;
      if (ev.type === 'on') s.noteOn(ev.id ?? 0, ev.note ?? 60, ev.vel ?? 0.8);
      else if (ev.type === 'off') s.noteOff(ev.id ?? 0);
      else if (ev.type === 'sustain') s.setSustain(!!ev.on);
      else if (ev.type === 'param') s.setParam(ev.key ?? '', ev.value ?? 0);
    }
    if (e >= evs.length && next === total) break;
  }
  return [L, R];
}

export function mono(l: Float32Array, r: Float32Array): Float32Array {
  const out = new Float32Array(l.length);
  for (let i = 0; i < l.length; i++) out[i] = 0.5 * ((l[i] as number) + (r[i] as number));
  return out;
}

export function slice(x: Float32Array, sr: number, from: number, to: number): Float32Array {
  return x.subarray(Math.round(from * sr), Math.min(x.length, Math.round(to * sr)));
}

export function rms(x: Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += (x[i] as number) ** 2;
  return Math.sqrt(s / Math.max(1, x.length));
}

export function peak(x: Float32Array): number {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i] as number));
  return p;
}

export const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-12));

/** in-place radix-2 FFT */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j] as number, re[i] as number];
      [im[i], im[j]] = [im[j] as number, im[i] as number];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = (re[b] as number) * cr - (im[b] as number) * ci;
        const ti = (re[b] as number) * ci + (im[b] as number) * cr;
        re[b] = (re[a] as number) - tr;
        im[b] = (im[a] as number) - ti;
        re[a] = (re[a] as number) + tr;
        im[a] = (im[a] as number) + ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

export interface Spectrum {
  mag: Float64Array;
  binHz: number;
}

/** Hann-windowed magnitude spectrum of the segment, zero-padded to a power of two (≥ minSize). */
export function spectrum(x: Float32Array, sr: number, minSize = 1 << 15): Spectrum {
  let n = 1;
  while (n < Math.max(x.length, minSize)) n <<= 1;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const m = x.length;
  let wsum = 0;
  for (let i = 0; i < m; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, m - 1));
    re[i] = (x[i] as number) * w;
    wsum += w;
  }
  fft(re, im);
  const mag = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) mag[i] = (2 * Math.hypot(re[i] as number, im[i] as number)) / wsum;
  return { mag, binHz: sr / n };
}

/** strongest peak within ±tolHz of f, with parabolic interpolation: returns frequency and amplitude */
export function peakNear(s: Spectrum, f: number, tolHz: number): { f: number; amp: number } {
  const lo = Math.max(1, Math.floor((f - tolHz) / s.binHz));
  const hi = Math.min(s.mag.length - 2, Math.ceil((f + tolHz) / s.binHz));
  let best = lo;
  for (let i = lo; i <= hi; i++) if ((s.mag[i] as number) > (s.mag[best] as number)) best = i;
  const a = Math.log((s.mag[best - 1] as number) + 1e-20);
  const b = Math.log((s.mag[best] as number) + 1e-20);
  const c = Math.log((s.mag[best + 1] as number) + 1e-20);
  const d = (a - 2 * b + c) === 0 ? 0 : (0.5 * (a - c)) / (a - 2 * b + c);
  return { f: (best + d) * s.binHz, amp: Math.exp(b - 0.25 * (a - c) * d) };
}

/** amplitude-weighted mean frequency */
export function centroid(s: Spectrum, minHz = 20, maxHz = 20000): number {
  let num = 0;
  let den = 0;
  const lo = Math.floor(minHz / s.binHz);
  const hi = Math.min(s.mag.length, Math.ceil(maxHz / s.binHz));
  for (let i = lo; i < hi; i++) {
    const m = s.mag[i] as number;
    num += m * i * s.binHz;
    den += m;
  }
  return den ? num / den : 0;
}

/** energy fraction above a frequency */
export function energyAbove(s: Spectrum, hz: number): number {
  let hiE = 0;
  let all = 0;
  const k = Math.floor(hz / s.binHz);
  for (let i = 1; i < s.mag.length; i++) {
    const e = (s.mag[i] as number) ** 2;
    all += e;
    if (i >= k) hiE += e;
  }
  return all ? hiE / all : 0;
}

/** RMS envelope in dB per window */
export function envelopeDb(x: Float32Array, sr: number, windowSec: number): number[] {
  const w = Math.max(1, Math.round(windowSec * sr));
  const out: number[] = [];
  for (let i = 0; i + w <= x.length; i += w) out.push(db(rms(x.subarray(i, i + w))));
  return out;
}

/** amplitude of a frequency component over time, via short-time Goertzel-like projection */
export function toneTrack(x: Float32Array, sr: number, f: number, windowSec: number): number[] {
  const w = Math.round(windowSec * sr);
  const out: number[] = [];
  for (let s0 = 0; s0 + w <= x.length; s0 += w) {
    let c = 0;
    let si = 0;
    let wsum = 0;
    for (let i = 0; i < w; i++) {
      const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (w - 1));
      const ph = (2 * Math.PI * f * (s0 + i)) / sr;
      c += (x[s0 + i] as number) * win * Math.cos(ph);
      si += (x[s0 + i] as number) * win * Math.sin(ph);
      wsum += win;
    }
    out.push((2 * Math.hypot(c, si)) / wsum);
  }
  return out;
}

export function hasBadSamples(...bufs: Float32Array[]): boolean {
  for (const b of bufs) for (let i = 0; i < b.length; i++) if (!Number.isFinite(b[i] as number)) return true;
  return false;
}
