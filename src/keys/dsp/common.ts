/**
 * Small DSP building blocks shared by the Keyforge engines. Everything here
 * runs inside the AudioWorklet: no allocation in per-sample paths and no
 * APIs missing from AudioWorkletGlobalScope.
 */

export const TWO_PI = Math.PI * 2;
export const LN_1000 = Math.log(1000);
/** maximum frames rendered per call (AudioWorklet render quantum is 128) */
export const MAX_BLOCK = 128;

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function midiToHz(n: number): number {
  return 440 * Math.pow(2, (n - 69) / 12);
}

/** Deterministic pseudo-random value in [0, 1) from two integers (per-note "manufacturing" variation). */
export function hash01(a: number, b: number): number {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Piecewise-linear interpolation in a table of [x, y] pairs (x ascending). */
export function interpTable(table: readonly (readonly [number, number])[], x: number): number {
  const first = table[0] as readonly [number, number];
  if (x <= first[0]) return first[1];
  for (let i = 1; i < table.length; i++) {
    const b = table[i] as readonly [number, number];
    if (x <= b[0]) {
      const a = table[i - 1] as readonly [number, number];
      return a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]);
    }
  }
  return (table[table.length - 1] as readonly [number, number])[1];
}

/** Padé tanh approximation, exact-ish for |x| < 3 and saturating beyond. */
export function fastTanh(x: number): number {
  if (x > 3) return 1;
  if (x < -3) return -1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

/** Per-sample one-pole smoother toward a target (time constant in seconds). */
export class Smoother {
  value: number;
  target: number;
  private coef = 0;

  constructor(value: number) {
    this.value = value;
    this.target = value;
  }

  setTime(seconds: number, sampleRate: number): void {
    this.coef = Math.exp(-1 / Math.max(1, seconds * sampleRate));
  }

  next(): number {
    this.value = this.target + (this.value - this.target) * this.coef;
    return this.value;
  }

  /** advance n samples at once (control-rate use) */
  advance(n: number): number {
    this.value = this.target + (this.value - this.target) * Math.pow(this.coef, n);
    return this.value;
  }
}

/** DC blocking high-pass (y = x - x1 + R·y1). */
export class DcBlocker {
  private x1 = 0;
  private y1 = 0;
  private r = 0.995;

  setCutoff(hz: number, sampleRate: number): void {
    this.r = Math.exp((-TWO_PI * hz) / sampleRate);
  }

  process(x: number): number {
    const y = x - this.x1 + this.r * this.y1;
    this.x1 = x;
    this.y1 = y;
    return y;
  }

  reset(): void {
    this.x1 = 0;
    this.y1 = 0;
  }
}

/** One-pole low-pass. */
export class OnePole {
  y = 0;
  private a = 0;

  setCutoff(hz: number, sampleRate: number): void {
    this.a = Math.exp((-TWO_PI * Math.max(1, hz)) / sampleRate);
  }

  process(x: number): number {
    this.y = x + (this.y - x) * this.a;
    return this.y;
  }
}

/** Power-of-two circular delay line with fractional (linear or cubic) reads. */
export class DelayLine {
  private readonly buf: Float64Array;
  private readonly mask: number;
  private w = 0;

  constructor(maxSamples: number) {
    let size = 1;
    while (size < maxSamples + 4) size <<= 1;
    this.buf = new Float64Array(size);
    this.mask = size - 1;
  }

  write(x: number): void {
    this.buf[this.w] = x;
    this.w = (this.w + 1) & this.mask;
  }

  /** value written `delay` samples ago (delay ≥ 1), linear interpolation */
  read(delay: number): number {
    const d = Math.max(1, delay);
    const i = Math.floor(d);
    const f = d - i;
    const a = this.buf[(this.w - i) & this.mask] as number;
    const b = this.buf[(this.w - i - 1) & this.mask] as number;
    return a + (b - a) * f;
  }

  /** 4-point Hermite interpolation: smoother for modulated delays (doppler, chorus) */
  readCubic(delay: number): number {
    const d = Math.max(2, delay);
    const i = Math.floor(d);
    const f = d - i;
    const m = this.mask;
    const xm1 = this.buf[(this.w - i + 1) & m] as number;
    const x0 = this.buf[(this.w - i) & m] as number;
    const x1 = this.buf[(this.w - i - 1) & m] as number;
    const x2 = this.buf[(this.w - i - 2) & m] as number;
    const c1 = 0.5 * (x1 - xm1);
    const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
    const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    return ((c3 * f + c2) * f + c1) * f + x0;
  }

  clear(): void {
    this.buf.fill(0);
  }
}

/**
 * Two-pole low-pass (TPT state-variable form, fixed damping): used for
 * "lid"/tone controls on the engine outputs.
 */
export class ToneFilter {
  private ic1 = 0;
  private ic2 = 0;
  private a1 = 1;
  private a2 = 0;
  private a3 = 0;

  set(cutoff: number, sampleRate: number, q = 0.7071): void {
    const g = Math.tan((Math.PI * clamp(cutoff, 10, sampleRate * 0.49)) / sampleRate);
    const k = 1 / q;
    this.a1 = 1 / (1 + g * (g + k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }

  process(x: number): number {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    return v2;
  }
}

/**
 * Exponentially decaying complex resonator: z ← p·z + g·x with p = r·e^{iω}.
 * The imaginary part is a damped sinusoid; a unit impulse gives amplitude g.
 */
export function resonatorCoefs(freq: number, t60: number, sampleRate: number, out: { a: number; b: number }): void {
  const r = Math.exp(-LN_1000 / Math.max(1, t60 * sampleRate));
  const w = (TWO_PI * freq) / sampleRate;
  out.a = r * Math.cos(w);
  out.b = r * Math.sin(w);
}

/** Equal-power pan gains for p in [-1, 1]. */
export function panGains(p: number, out: { l: number; r: number }): void {
  const a = ((clamp(p, -1, 1) + 1) * Math.PI) / 4;
  out.l = Math.cos(a);
  out.r = Math.sin(a);
}

/** Interface every Keyforge engine implements; KeysSynth drives it. */
export interface KeysEngine {
  setParams(p: Record<string, number>): void;
  noteOn(id: number, note: number, velocity: number): void;
  noteOff(id: number): void;
  setSustain(on: boolean): void;
  /** -1..1 (±2 semitones) */
  setBend(value: number): void;
  allNotesOff(): void;
  panic(): void;
  /** add `count` frames into outL/outR starting at `offset` (count ≤ MAX_BLOCK) */
  render(outL: Float32Array, outR: Float32Array, offset: number, count: number): void;
  activeVoices(): number;
  /** song tempo, for tempo-synced effects */
  setTempo?(bpm: number): void;
}

export const BEND_SEMITONES = 2;

/**
 * Bookkeeping for which note ids hold a voice down, shared by the engines.
 * A voice is "held" while any id is down, and "sustained" if released while
 * the pedal is down.
 */
export class HeldIds {
  ids: number[] = [];
  add(id: number): void {
    if (!this.ids.includes(id)) this.ids.push(id);
  }
  remove(id: number): boolean {
    const i = this.ids.indexOf(id);
    if (i < 0) return false;
    this.ids.splice(i, 1);
    return true;
  }
  has(id: number): boolean {
    return this.ids.includes(id);
  }
  get empty(): boolean {
    return this.ids.length === 0;
  }
  clear(): void {
    this.ids.length = 0;
  }
}

/** delay lengths (ms) of the reverb network: mutually prime-ish so the echoes don't line up */
const FDN_MS = [29.7, 37.1, 41.1, 43.7, 53.3, 59.1, 67.3, 73.1];

/**
 * Stereo 8-line feedback delay network reverb (Hadamard feedback matrix,
 * per-line damping, pre-delay). Used as the piano's room and the analog
 * engine's "Space". Allocation happens only in the constructor.
 */
export class FdnReverb {
  private readonly lines: DelayLine[] = [];
  private readonly len = new Float64Array(8);
  private readonly gain = new Float64Array(8);
  private readonly lp = new Float64Array(8);
  private readonly tmp = new Float64Array(8);
  private damp = 0.3;
  private readonly pre: DelayLine;
  private preSamples = 1;
  private readonly sr: number;
  /** slow delay-length modulation: smears the tail so it fills the gaps between partials */
  private modDepth = 0;
  private readonly modPhase = new Float64Array(8);
  private readonly modInc = new Float64Array(8);
  outL = 0;
  outR = 0;

  /** depth in ms (0 = off), base rate in Hz (each line drifts at a slightly different rate) */
  setModulation(depthMs: number, rateHz: number): void {
    this.modDepth = (depthMs / 1000) * this.sr;
    for (let i = 0; i < 8; i++) {
      this.modInc[i] = (rateHz * (0.7 + 0.09 * i)) / this.sr;
      this.modPhase[i] = i / 8;
    }
  }

  constructor(sampleRate: number, maxSize = 1.6) {
    this.sr = sampleRate;
    for (let i = 0; i < 8; i++) this.lines.push(new DelayLine(Math.ceil(((FDN_MS[i] as number) / 1000) * maxSize * sampleRate) + 4));
    this.pre = new DelayLine(Math.ceil(0.08 * sampleRate));
  }

  /** t60 seconds, size scales the delay lengths (room size), damping cutoff in Hz, pre-delay seconds */
  set(t60: number, size: number, dampHz: number, preDelay: number): void {
    for (let i = 0; i < 8; i++) {
      const n = Math.max(8, Math.round(((FDN_MS[i] as number) / 1000) * size * this.sr));
      this.len[i] = n;
      this.gain[i] = Math.pow(10, (-3 * n) / (Math.max(0.05, t60) * this.sr));
    }
    this.damp = Math.exp((-TWO_PI * dampHz) / this.sr);
    this.preSamples = Math.max(1, Math.round(preDelay * this.sr));
  }

  process(inL: number, inR: number): void {
    this.pre.write(0.5 * (inL + inR));
    const x = this.pre.read(this.preSamples);
    const t = this.tmp;
    const md = this.modDepth;
    for (let i = 0; i < 8; i++) {
      let y: number;
      if (md > 0) {
        let ph = (this.modPhase[i] as number) + (this.modInc[i] as number);
        if (ph >= 1) ph -= 1;
        this.modPhase[i] = ph;
        y = (this.lines[i] as DelayLine).readCubic((this.len[i] as number) + md * (1 + Math.sin(TWO_PI * ph)));
      } else y = (this.lines[i] as DelayLine).read(this.len[i] as number);
      const l = y + ((this.lp[i] as number) - y) * this.damp;
      this.lp[i] = l;
      t[i] = l;
    }
    // output taps: even lines left, odd lines right
    this.outL = ((t[0] as number) + (t[2] as number) + (t[4] as number) + (t[6] as number)) * 0.5;
    this.outR = ((t[1] as number) + (t[3] as number) + (t[5] as number) + (t[7] as number)) * 0.5;
    // fast 8-point Walsh–Hadamard transform (orthogonal after the 1/√8 scale)
    for (let h = 1; h < 8; h <<= 1) {
      for (let i = 0; i < 8; i += h << 1) {
        for (let j = i; j < i + h; j++) {
          const a = t[j] as number;
          const b = t[j + h] as number;
          t[j] = a + b;
          t[j + h] = a - b;
        }
      }
    }
    const s = 1 / Math.sqrt(8);
    for (let i = 0; i < 8; i++) {
      const inj = i & 1 ? inR - inL * 0.3 : inL - inR * 0.3;
      (this.lines[i] as DelayLine).write((t[i] as number) * s * (this.gain[i] as number) + (x * 0.6 + inj * 0.4) * 0.35);
    }
  }

  clear(): void {
    for (const l of this.lines) l.clear();
    this.pre.clear();
    this.lp.fill(0);
    this.outL = 0;
    this.outR = 0;
  }
}

/** Stereo ping-pong delay with a darkening feedback path. */
export class PingPongDelay {
  private readonly l: DelayLine;
  private readonly r: DelayLine;
  private lpL = 0;
  private lpR = 0;
  private readonly damp: number;
  private samples = 1;
  feedback = 0.45;
  outL = 0;
  outR = 0;

  constructor(sampleRate: number, maxSec = 1.3) {
    this.l = new DelayLine(Math.ceil(maxSec * sampleRate) + 4);
    this.r = new DelayLine(Math.ceil(maxSec * sampleRate) + 4);
    this.damp = Math.exp((-TWO_PI * 4500) / sampleRate);
    this.sr = sampleRate;
  }

  private readonly sr: number;

  setTime(seconds: number): void {
    this.samples = Math.max(1, Math.round(seconds * this.sr));
  }

  process(inL: number, inR: number): void {
    const yl = this.l.read(this.samples);
    const yr = this.r.read(this.samples);
    this.lpL = yl + (this.lpL - yl) * this.damp;
    this.lpR = yr + (this.lpR - yr) * this.damp;
    // input enters the left line (mono sum), echoes bounce L → R → L
    this.l.write(0.5 * (inL + inR) + this.lpR * this.feedback);
    this.r.write(this.lpL * this.feedback);
    this.outL = yl;
    this.outR = yr;
  }

  clear(): void {
    this.l.clear();
    this.r.clear();
    this.lpL = 0;
    this.lpR = 0;
  }
}
