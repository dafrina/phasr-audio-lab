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
