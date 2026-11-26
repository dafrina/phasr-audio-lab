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
  const model = src.model ?? 0;
  const len = src.length;
  const tail = voice === 'crash' || voice === 'hatOpen' ? 1.3 : 1.15;
  const n = Math.max(1, Math.round(len * tail * sampleRate) + Math.round(0.005 * sampleRate));
  const out = new Float32Array(n);
  // (model 0 keeps the original seed, so classic voices render exactly as before)
  const rnd = noiseGen(0x51f0 + voice.length * 977 + Math.round(tone * 1000) * 13 + Math.round(snap * 1000) + model * 7919);
  const sr = sampleRate;
  let phase = 0;
  if (model > 0) renderAlt(voice, model, tone, snap, len, sr, out, rnd);
  else switch (voice) {
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

/**
 * The alternative characters of each voice (model 1 and 2); model 0 is the
 * classic recipe above. Same three macros (tone, snap, length), different
 * synthesis, so every pad has a few genuinely different sounds to pick from.
 */
function renderAlt(voice: SynthSource['voice'], model: number, tone: number, snap: number, len: number, sr: number, out: Float32Array, rnd: () => number): void {
  const n = out.length;
  let phase = 0;
  switch (voice) {
    case 'kick': {
      if (model === 1) {
        // 909: a shorter, harder pitch sweep, a noisy attack and a touch of saturation
        const fEnd = 45 + tone * 35;
        const fStart = fEnd * (4 + snap * 5);
        const click = new OnePole(1 - Math.exp((-TWO_PI * 1500) / sr));
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          const f = fEnd + (fStart - fEnd) * Math.exp(-t / 0.012);
          phase += f / sr;
          let v = Math.sin(TWO_PI * phase) * decayEnv(t, len);
          v += click.hp(rnd()) * (0.4 + snap) * Math.exp(-t / 0.006);
          out[i] = Math.tanh(v * 2);
        }
      } else {
        // distorted (hard techno): long low boom driven into clipping, then filtered
        const fEnd = 40 + tone * 30;
        const lp = OnePole.lp(1800 + snap * 4000, sr);
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          const f = fEnd + fEnd * 3 * Math.exp(-t / 0.02);
          phase += f / sr;
          const v = Math.sin(TWO_PI * phase) * decayEnv(t, len) * (4 + snap * 6);
          out[i] = lp.lp(Math.tanh(v) + 0.25 * Math.tanh(v * 3) * Math.exp(-t / 0.03));
        }
      }
      break;
    }
    case 'snare': {
      if (model === 1) {
        // 909: two tuned body modes and a bright, sizzly noise
        const f1 = 180 + tone * 80;
        const f2 = f1 * 1.83;
        const hp = new OnePole(1 - Math.exp((-TWO_PI * 3000) / sr));
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          const body = (Math.sin(TWO_PI * f1 * t) + 0.6 * Math.sin(TWO_PI * f2 * t)) * decayEnv(t, Math.min(len, 0.09));
          const noise = hp.hp(rnd()) * decayEnv(t, len) * (0.6 + snap);
          out[i] = body * 0.6 + noise;
        }
      } else {
        // trap / rimshot snare: high, tight crack layered with a short clap
        const f = 300 + tone * 200;
        const hp = new OnePole(1 - Math.exp((-TWO_PI * 1800) / sr));
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          let clap = 0;
          for (const b of [0, 0.008, 0.016]) if (t >= b) clap = Math.max(clap, Math.exp(-(t - b) / 0.005));
          const crack = Math.sin(TWO_PI * f * t) * Math.exp(-t / 0.02);
          out[i] = crack * 0.7 + hp.hp(rnd()) * (clap * 0.8 + decayEnv(t, len) * (0.5 + snap * 0.5));
        }
      }
      break;
    }
    case 'clap': {
      const lp = OnePole.lp(2000 + tone * 4000, sr);
      const hp = new OnePole(1 - Math.exp((-TWO_PI * (model === 1 ? 900 : 1500)) / sr));
      const bursts = model === 1 ? [0, 0.009, 0.018, 0.027, 0.036] : [0, 0.007];
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        let env = 0;
        for (const b of bursts) if (t >= b) env = Math.max(env, Math.exp(-(t - b) / (0.005 + snap * 0.004)));
        const last = bursts[bursts.length - 1] as number;
        // 909-style: a longer, roomy tail; snap: almost none
        env = Math.max(env, t > last ? (model === 1 ? 0.7 : 0.25) * decayEnv(t - last, model === 1 ? len * 1.4 : len * 0.5) : 0);
        out[i] = hp.hp(lp.lp(rnd())) * env * 2.2;
      }
      break;
    }
    case 'rim': {
      if (model === 1) {
        // woodblock: two hollow sine modes
        const f = 800 + tone * 700;
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          const e = decayEnv(t, Math.min(len, 0.12));
          out[i] = (Math.sin(TWO_PI * f * t) + 0.5 * Math.sin(TWO_PI * f * 2.76 * t) + rnd() * 0.2 * snap * Math.exp(-t / 0.002)) * e;
        }
      } else {
        // click: a bare, bright tick for minimal grooves
        const hp = new OnePole(1 - Math.exp((-TWO_PI * (3000 + tone * 5000)) / sr));
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          out[i] = hp.hp(rnd()) * Math.exp(-t / (0.002 + snap * 0.004));
        }
      }
      break;
    }
    case 'tom': {
      if (model === 1) {
        // electronic (Simmons-style): a big downward sweep with noise
        const f = 80 + tone * 200;
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          phase += (f * (1 + 1.5 * Math.exp(-t / 0.12))) / sr;
          out[i] = Math.sin(TWO_PI * phase) * decayEnv(t, len) + rnd() * 0.25 * snap * decayEnv(t, len * 0.4);
        }
      } else {
        // conga: higher, short, with a hand slap
        const f = 180 + tone * 260;
        const hp = new OnePole(1 - Math.exp((-TWO_PI * 2500) / sr));
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          phase += (f * (1 + 0.15 * Math.exp(-t / 0.01))) / sr;
          out[i] = Math.sin(TWO_PI * phase) * decayEnv(t, Math.min(len, 0.35)) + hp.hp(rnd()) * snap * Math.exp(-t / 0.004);
        }
      }
      break;
    }
    case 'hatClosed':
    case 'hatOpen':
    case 'crash': {
      if (voice === 'crash') {
        if (model === 1) {
          // ride: metal with a bell partial, long and washy
          const base = 380 + tone * 200;
          const hp = new OnePole(1 - Math.exp((-TWO_PI * 2500) / sr));
          for (let i = 0; i < n; i++) {
            const t = i / sr;
            const bell = Math.sin(TWO_PI * base * 5.1 * t) * Math.exp(-t / 0.25) * (0.3 + snap * 0.5);
            out[i] = (hp.hp(metal(t, base) * 0.7 + rnd() * 0.25) + bell) * decayEnv(t, len) * 1.2;
          }
        } else {
          // reverse crash: swells up to the hit
          const hp = new OnePole(1 - Math.exp((-TWO_PI * 3000) / sr));
          const base = 300 + tone * 250;
          for (let i = 0; i < n; i++) {
            const t = i / sr;
            const x = Math.min(1, t / Math.max(0.02, len));
            out[i] = hp.hp(metal(t, base) * 0.5 + rnd() * (0.5 + snap * 0.5)) * x * x * (t <= len ? 1 : Math.exp(-(t - len) / 0.01));
          }
        }
        break;
      }
      if (model === 1) {
        // 808 hat: six square oscillators through a bright band-pass
        const base = 320 + tone * 220;
        const bp1 = new OnePole(1 - Math.exp((-TWO_PI * 7000) / sr));
        const bp2 = OnePole.lp(12000, sr);
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          out[i] = bp2.lp(bp1.hp(metal(t, base) + rnd() * 0.15 * snap)) * decayEnv(t, len) * 2;
        }
      } else {
        // noise hat: pure filtered noise, crisp and modern
        const hp = new OnePole(1 - Math.exp((-TWO_PI * (5000 + tone * 5000)) / sr));
        const hp2 = new OnePole(1 - Math.exp((-TWO_PI * 8000) / sr));
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          out[i] = hp2.hp(hp.hp(rnd())) * decayEnv(t, len) * (1 + snap * Math.exp(-t / 0.003));
        }
      }
      break;
    }
    case 'cowbell': {
      if (model === 1) {
        // agogo / bell: a small FM bell
        const fc = 700 + tone * 900;
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          const idx = (0.8 + snap * 3) * Math.exp(-t / 0.08);
          out[i] = Math.sin(TWO_PI * fc * t + idx * Math.sin(TWO_PI * fc * 3.5 * t)) * decayEnv(t, len);
        }
      } else {
        // clave: a short, woody high tone
        const f = 2000 + tone * 1200;
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          out[i] = Math.sin(TWO_PI * f * t) * decayEnv(t, Math.min(len, 0.06 + snap * 0.04));
        }
      }
      break;
    }
    case 'shaker': {
      if (model === 1) {
        // tambourine: noise and jingles
        const hp = new OnePole(1 - Math.exp((-TWO_PI * 5000) / sr));
        const base = 900 + tone * 600;
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          const jingle = Math.sin(TWO_PI * base * 3.1 * t) * Math.sin(TWO_PI * base * 4.7 * t);
          out[i] = (hp.hp(rnd()) * 0.8 + jingle * (0.3 + snap * 0.5)) * (1 - Math.exp(-t / 0.002)) * decayEnv(t, len) * 1.4;
        }
      } else {
        // cabasa: very bright, very short
        const hp = new OnePole(1 - Math.exp((-TWO_PI * (8000 + tone * 4000)) / sr));
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          out[i] = hp.hp(rnd()) * (1 - Math.exp(-t / (0.002 + (1 - snap) * 0.01))) * decayEnv(t, Math.min(len, 0.1)) * 1.8;
        }
      }
      break;
    }
    case 'perc': {
      if (model === 1) {
        // bongo / bloop: a quick downward pitch drop
        const f = 250 + tone * 500;
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          phase += (f * (1 + (0.5 + snap) * Math.exp(-t / 0.015))) / sr;
          out[i] = Math.sin(TWO_PI * phase) * decayEnv(t, len);
        }
      } else {
        // metal ping: an inharmonic ring
        const f = 600 + tone * 1400;
        const ratios = [1, 2.41, 3.73, 5.26];
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          let v = 0;
          ratios.forEach((r, k) => (v += Math.sin(TWO_PI * f * r * t) * Math.exp(-t / (len * (1 - k * 0.2) + 0.01)) * (k === 0 ? 1 : 0.3 + snap * 0.4)));
          out[i] = v * 0.6;
        }
      }
      break;
    }
    case 'zap': {
      if (model === 1) {
        // laser: an FM chirp falling fast
        const fStart = 2500 + tone * 4000;
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          const f = 80 + fStart * Math.exp(-t / 0.03);
          phase += f / sr;
          out[i] = Math.sin(TWO_PI * phase + (1 + snap * 3) * Math.sin(TWO_PI * phase * 0.5)) * decayEnv(t, len);
        }
      } else {
        // noise sweep: noise through a falling resonant filter
        let lp1 = 0;
        let bp = 0;
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          const fc = 200 + (3000 + tone * 6000) * Math.exp(-t / Math.max(0.02, len * 0.5));
          const g = 2 * Math.sin((Math.PI * Math.min(fc, sr * 0.2)) / sr);
          const q = 0.3 - snap * 0.25;
          const x = rnd();
          lp1 += g * bp;
          const hp = x - lp1 - q * bp;
          bp += g * hp;
          out[i] = bp * decayEnv(t, len) * 2;
        }
      }
      break;
    }
  }
}

/** Cache key for a rendered voice. */
export function voiceKey(src: SynthSource, sampleRate: number): string {
  return `${src.voice}|${src.model ?? 0}|${src.tone.toFixed(3)}|${src.snap.toFixed(3)}|${src.length.toFixed(3)}|${sampleRate}`;
}
