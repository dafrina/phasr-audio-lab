/**
 * Building blocks of the drum synthesis (pure, double precision, no Web Audio).
 *
 * Everything is specified in Hz and seconds, so a voice sounds the same at any
 * sample rate; nothing generates energy above the band it is meant for:
 *  - tones are sums of sine partials (rotating phasors), and a partial that
 *    would land above `bandTop(sr)` is left out, so squares, bells and metal
 *    are band-limited by construction (no aliased fizz);
 *  - noise is white at 48 kHz density at every rate (scaled by √(sr / 48 k)), shaped by filters;
 *  - filters are causal IIRs (RBJ biquads, a TPT state-variable filter): no pre-ringing.
 */

export const TWO_PI = Math.PI * 2;

/** The highest frequency a voice puts energy at: 20 kHz, or a little under Nyquist at low rates. */
export function bandTop(sr: number): number {
  return Math.min(20000, sr * 0.45);
}

/** Deterministic white noise in [−1, 1) (xorshift32): the same seed always gives the same hit. */
export function noiseGen(seed: number): () => number {
  let s = seed | 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s | 0) / 2147483648;
  };
}

/** Biquad filter (RBJ cookbook), transposed direct form II. */
export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = 0;
  private z2 = 0;

  private set(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): this {
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
    return this;
  }

  private static w(fc: number, sr: number): { cs: number; sn: number } {
    const w0 = (TWO_PI * Math.min(fc, sr * 0.45)) / sr;
    return { cs: Math.cos(w0), sn: Math.sin(w0) };
  }

  static lowpass(fc: number, q: number, sr: number): Biquad {
    const { cs, sn } = Biquad.w(fc, sr);
    const al = sn / (2 * q);
    return new Biquad().set((1 - cs) / 2, 1 - cs, (1 - cs) / 2, 1 + al, -2 * cs, 1 - al);
  }

  static highpass(fc: number, q: number, sr: number): Biquad {
    const { cs, sn } = Biquad.w(fc, sr);
    const al = sn / (2 * q);
    return new Biquad().set((1 + cs) / 2, -(1 + cs), (1 + cs) / 2, 1 + al, -2 * cs, 1 - al);
  }

  /** band-pass with 0 dB at the centre */
  static bandpass(fc: number, q: number, sr: number): Biquad {
    const { cs, sn } = Biquad.w(fc, sr);
    const al = sn / (2 * q);
    return new Biquad().set(al, 0, -al, 1 + al, -2 * cs, 1 - al);
  }

  /** peaking EQ: `db` at fc */
  static peak(fc: number, q: number, db: number, sr: number): Biquad {
    const { cs, sn } = Biquad.w(fc, sr);
    const A = Math.pow(10, db / 40);
    const al = sn / (2 * q);
    return new Biquad().set(1 + al * A, -2 * cs, 1 - al * A, 1 + al / A, -2 * cs, 1 - al / A);
  }

  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  /** magnitude response at f (to leave out partials a filter would remove anyway) */
  gainAt(f: number, sr: number): number {
    const w = (TWO_PI * f) / sr;
    const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = this.b0 + this.b1 * c1 + this.b2 * c2;
    const ni = -(this.b1 * s1 + this.b2 * s2);
    const dr = 1 + this.a1 * c1 + this.a2 * c2;
    const di = -(this.a1 * s1 + this.a2 * s2);
    return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
  }
}

/** A cascade of biquads (steeper slopes); `gainAt` is the product. */
export class Chain {
  constructor(readonly stages: Biquad[]) {}
  process(x: number): number {
    let y = x;
    for (const s of this.stages) y = s.process(y);
    return y;
  }
  gainAt(f: number, sr: number): number {
    let g = 1;
    for (const s of this.stages) g *= s.gainAt(f, sr);
    return g;
  }
}

/** Butterworth Q values for 4th- and 8th-order cascades */
export const BW4 = [0.5411961, 1.306563];
export const BW8 = [0.5097956, 0.6013449, 0.8999762, 2.5629154];

/**
 * State-variable filter, topology-preserving transform (Zavalishin): stable and
 * well-behaved when its cutoff moves every sample (the sweeps).
 */
export class Svf {
  private ic1 = 0;
  private ic2 = 0;
  lp = 0;
  bp = 0;
  hp = 0;
  /** fc: cutoff (Hz), res: 1/Q */
  process(x: number, fc: number, res: number, sr: number): void {
    const g = Math.tan((Math.PI * Math.min(fc, sr * 0.45)) / sr);
    const a1 = 1 / (1 + g * (g + res));
    const a2 = g * a1;
    const a3 = g * a2;
    const v3 = x - this.ic2;
    const v1 = a1 * this.ic1 + a2 * v3;
    const v2 = this.ic2 + a2 * this.ic1 + a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2;
    this.bp = v1;
    this.hp = x - res * v1 - v2;
  }
}

/**
 * A bank of decaying sine partials as rotating phasors (4 multiplies per partial
 * per sample, no Math.sin in the loop). Partials above `bandTop` are never added.
 */
export class Partials {
  private c: number[] = [];
  private s: number[] = [];
  private cw: number[] = [];
  private sw: number[] = [];
  private amp: number[] = [];
  private dec: number[] = [];
  constructor(private readonly sr: number) {}

  get size(): number {
    return this.c.length;
  }

  /** a partial at f Hz, amplitude a, reaching −60 dB after t60 s (Infinity: no decay of its own) */
  add(f: number, a: number, t60 = Infinity, phase = 0): void {
    const top = bandTop(this.sr);
    if (!(f > 0) || f >= top || a === 0) return;
    // fade partials out over the last 10 % below the band top instead of a hard cut
    const taper = Math.min(1, (top - f) / (0.1 * top));
    const w = (TWO_PI * f) / this.sr;
    this.c.push(Math.cos(phase));
    this.s.push(Math.sin(phase));
    this.cw.push(Math.cos(w));
    this.sw.push(Math.sin(w));
    this.amp.push(a * taper);
    this.dec.push(Number.isFinite(t60) ? Math.exp(-6.9 / (t60 * this.sr)) : 1);
  }

  /**
   * A band-limited square wave at f (odd harmonics 4/(πk)). `keep(freq)` can skip
   * harmonics that a filter after the bank removes anyway (saves work, same sound).
   * `phase`: where in its cycle it starts (π/2: mid-plateau, so two squares started
   * together are both at their crest at once).
   */
  addSquare(f: number, a: number, keep: (freq: number) => boolean = () => true, t60 = Infinity, phase = 0): void {
    const top = bandTop(this.sr);
    for (let k = 1; k * f < top; k += 2) if (keep(k * f)) this.add(k * f, (a * 4) / (Math.PI * k), t60, k * phase);
  }

  next(): number {
    let y = 0;
    const { c, s, cw, sw, amp, dec } = this;
    for (let i = 0; i < c.length; i++) {
      const ci = c[i] as number;
      const si = s[i] as number;
      const a = cw[i] as number;
      const b = sw[i] as number;
      y += (amp[i] as number) * si;
      c[i] = ci * a - si * b;
      s[i] = ci * b + si * a;
      amp[i] = (amp[i] as number) * (dec[i] as number);
    }
    return y;
  }
}

/**
 * Exponential decay reaching −60 dB at `len` seconds (`depth`: the natural log of the
 * drop at `len`, 6.9 = 60 dB); `curve` > 1 holds the start longer and drops faster at the end.
 */
export function decay(t: number, len: number, curve = 1, depth = 6.9): number {
  const x = t / Math.max(0.005, len);
  return Math.exp(-depth * (curve === 1 ? x : Math.pow(x, curve)));
}

/** Raised-cosine attack over `a` seconds (0 at t = 0, so a hit starts from silence without a step). */
export function attack(t: number, a: number): number {
  return t >= a ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * t) / a);
}

/**
 * A sine whose frequency falls (or rises) exponentially from f0 to f1 with time
 * constant tau; `harmonics` adds band-limited overtones locked to it (a cleaner
 * "drive" than a waveshaper, which would alias at the top of a sweep).
 */
export class Sweep {
  private phase: number;
  private df: number;
  private readonly k: number;
  /** phase0: π/2 starts on the crest — with a sub-millisecond attack, the sharpest onset a low tone can have */
  constructor(private readonly f1: number, f0: number, tau: number, private readonly sr: number, phase0 = 0) {
    this.phase = phase0;
    this.df = f0 - f1;
    this.k = Math.exp(-1 / (Math.max(1e-4, tau) * sr));
  }
  /** current frequency (Hz) */
  freq = 0;
  /** advance one sample; returns the phase (radians) to evaluate */
  next(): number {
    const p = this.phase;
    this.freq = this.f1 + this.df;
    this.phase += (TWO_PI * this.freq) / this.sr;
    if (this.phase > 1e6) this.phase %= TWO_PI;
    this.df *= this.k;
    return p;
  }
}

/**
 * cos(kφ) summed with weights h[k−1], each only while k·f stays inside the band.
 * Cosines: every overtone crests with the fundamental at φ = 0, so a hit that starts
 * there starts on its loudest crest (the sharpest attack a low tone can have).
 */
export function harmonicSum(phase: number, f: number, h: readonly number[], sr: number): number {
  const top = bandTop(sr);
  let y = 0;
  for (let k = 1; k <= h.length; k++) {
    const w = h[k - 1] as number;
    if (w === 0) continue;
    const fk = k * f;
    if (fk >= top) break;
    y += w * Math.min(1, (top - fk) / (0.1 * top)) * Math.cos(k * phase);
  }
  return y;
}
