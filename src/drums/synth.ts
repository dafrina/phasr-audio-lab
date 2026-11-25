/**
 * Procedural drum synthesis for the built-in drum rack sounds (pure, no Web
 * Audio). Every voice is rendered once into a mono buffer from three macro
 * controls — tone (pitch/brightness), snap (transient/noise amount) and
 * length — using a seeded noise generator, so a kit always sounds identical
 * (realtime, export and tests).
 */
import type { DrumPadSource } from '../project/types';

type SynthSource = Extract<DrumPadSource, { kind: 'synth' }>;

const TWO_PI = Math.PI * 2;

function noiseGen(seed: number): () => number {
  let s = seed | 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s | 0) / 2147483648;
  };
}

/** One-pole filters (cheap, stable). */
class OnePole {
  private z = 0;
  constructor(private a: number) {}
  static lp(fc: number, sr: number): OnePole {
    return new OnePole(1 - Math.exp((-TWO_PI * fc) / sr));
  }
  lp(x: number): number {
    this.z += (x - this.z) * this.a;
    return this.z;
  }
  hp(x: number): number {
    return x - this.lp(x);
  }
}

/** Exponential decay reaching -60 dB at `len` seconds. */
function decayEnv(t: number, len: number): number {
  return Math.exp((-6.9 * t) / Math.max(0.005, len));
}

/** Sum of square waves at inharmonic ratios: the classic metallic hat/cymbal source. */
const METAL_RATIOS = [2, 3, 4.16, 5.43, 6.79, 8.21];
function metal(t: number, base: number): number {
  let v = 0;
  for (const r of METAL_RATIOS) v += Math.sin(TWO_PI * base * r * t) > 0 ? 1 : -1;
  return v / METAL_RATIOS.length;
}

export function renderDrumVoice(src: SynthSource, sampleRate: number): Float32Array<ArrayBuffer> {
  const { voice, tone, snap } = src;
  const len = src.length;
  const tail = voice === 'crash' || voice === 'hatOpen' ? 1.3 : 1.15;
  const n = Math.max(1, Math.round(len * tail * sampleRate) + Math.round(0.005 * sampleRate));
  const out = new Float32Array(n);
  const rnd = noiseGen(0x51f0 + voice.length * 977 + Math.round(tone * 1000) * 13 + Math.round(snap * 1000));
  const sr = sampleRate;
  let phase = 0;
  switch (voice) {
    case 'kick': {
      const fEnd = 38 + tone * 40;
      const fStart = fEnd * (2.5 + snap * 4);
      const sweep = 0.025 + (1 - snap) * 0.04;
      const click = OnePole.lp(4000, sr);
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const f = fEnd + (fStart - fEnd) * Math.exp(-t / sweep);
        phase += f / sr;
        let v = Math.sin(TWO_PI * phase) * decayEnv(t, len);
        v += click.lp(rnd()) * snap * 1.5 * Math.exp(-t / 0.003);
        out[i] = Math.tanh(v * 1.4);
      }
      break;
    }
    case 'snare': {
      const f = 160 + tone * 120;
      const hp = new OnePole(1 - Math.exp((-TWO_PI * 1200) / sr));
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        phase += (f * (1 + 0.5 * Math.exp(-t / 0.01))) / sr;
        const body = Math.sin(TWO_PI * phase) * decayEnv(t, Math.min(len, 0.12)) * (1 - snap * 0.5);
        const noise = hp.hp(rnd()) * decayEnv(t, len) * (0.4 + snap);
        out[i] = body + noise;
      }
      break;
    }
    case 'clap': {
      const lp = OnePole.lp(2500 + tone * 2500, sr);
      const hp = new OnePole(1 - Math.exp((-TWO_PI * 700) / sr));
      const bursts = [0, 0.011, 0.023, 0.034];
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        let env = 0;
        for (const b of bursts) if (t >= b) env = Math.max(env, Math.exp(-(t - b) / (0.006 + snap * 0.004)));
        env = Math.max(env, t > 0.034 ? 0.6 * decayEnv(t - 0.034, len) : 0);
        out[i] = hp.hp(lp.lp(rnd())) * env * 2.2;
      }
      break;
    }
    case 'rim': {
      const hp = new OnePole(1 - Math.exp((-TWO_PI * 2000) / sr));
      const f = 1400 + tone * 900;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const e = decayEnv(t, Math.min(len, 0.08));
        out[i] = (Math.sin(TWO_PI * f * t) * 0.8 + hp.hp(rnd()) * snap) * e;
      }
      break;
    }
    case 'tom': {
      const f = 70 + tone * 180;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        phase += (f * (1 + (0.6 + snap) * Math.exp(-t / 0.04))) / sr;
        out[i] = Math.sin(TWO_PI * phase) * decayEnv(t, len) + rnd() * 0.15 * snap * Math.exp(-t / 0.005);
      }
      break;
    }
    case 'hatClosed':
    case 'hatOpen':
    case 'crash': {
      const base = 280 + tone * 260;
      const hp = new OnePole(1 - Math.exp((-TWO_PI * (voice === 'crash' ? 3500 : 6500)) / sr));
      const hp2 = new OnePole(1 - Math.exp((-TWO_PI * 5000) / sr));
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const src = metal(t, base) * (1 - snap * 0.6) + rnd() * (0.3 + snap * 0.7);
        const env = voice === 'crash' ? decayEnv(t, len) * (1 - Math.exp(-t / 0.002)) : decayEnv(t, len);
        out[i] = hp2.hp(hp.hp(src)) * env * 1.6;
      }
      break;
    }
    case 'cowbell': {
      const f1 = 500 + tone * 150;
      const f2 = f1 * 1.48;
      const lp = OnePole.lp(3000, sr);
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const sq = (Math.sin(TWO_PI * f1 * t) > 0 ? 1 : -1) + (Math.sin(TWO_PI * f2 * t) > 0 ? 1 : -1);
        const e = Math.exp(-t / 0.01) * snap + decayEnv(t, len) * (1 - snap * 0.5);
        out[i] = lp.lp(sq * 0.5) * e;
      }
      break;
    }
    case 'shaker': {
      const hp = new OnePole(1 - Math.exp((-TWO_PI * (4000 + tone * 4000)) / sr));
      const atk = 0.004 + (1 - snap) * 0.02;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        out[i] = hp.hp(rnd()) * (1 - Math.exp(-t / atk)) * decayEnv(t, len) * 1.5;
      }
      break;
    }
    case 'perc': {
      // two-operator FM blip
      const fc = 300 + tone * 900;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const idx = (1 + snap * 6) * Math.exp(-t / 0.03);
        out[i] = Math.sin(TWO_PI * fc * t + idx * Math.sin(TWO_PI * fc * 1.41 * t)) * decayEnv(t, len);
      }
      break;
    }
    case 'zap': {
      const fStart = 1500 + tone * 3000;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const f = 60 + fStart * Math.exp(-t / (0.01 + (1 - snap) * 0.04));
        phase += f / sr;
        out[i] = Math.sin(TWO_PI * phase) * decayEnv(t, len);
      }
      break;
    }
  }
  // 1 ms fade-in to avoid DC clicks, normalize to -1 dBFS peak
  const fade = Math.min(n, Math.round(0.001 * sr));
  for (let i = 0; i < fade; i++) out[i] = (out[i] as number) * (i / fade);
  let pk = 0;
  for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(out[i] as number));
  if (pk > 1e-6) {
    const g = 0.89 / pk;
    for (let i = 0; i < n; i++) out[i] = (out[i] as number) * g;
  }
  return out;
}

/** Cache key for a rendered voice. */
export function voiceKey(src: SynthSource, sampleRate: number): string {
  return `${src.voice}|${src.tone.toFixed(3)}|${src.snap.toFixed(3)}|${src.length.toFixed(3)}|${sampleRate}`;
}
