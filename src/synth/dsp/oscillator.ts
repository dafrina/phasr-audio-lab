/**
 * Oscillator waveform kernels.
 *
 * Phase is normalized to [0, 1). `dt` is the phase increment per sample
 * (frequency / sampleRate).
 *
 * HQ mode uses PolyBLEP (polynomial band-limited step) residuals to smooth
 * the discontinuities of saw/square/pulse, which removes most audible
 * aliasing at negligible cost. The HQ triangle is produced by integrating the
 * band-limited square, with a gentle pull toward the ideal triangle so the
 * integrator can't drift. Classic mode uses the naive (aliasing) shapes for a
 * rawer, brighter character.
 */

export const WF_SINE = 0;
export const WF_TRIANGLE = 1;
export const WF_SAW = 2;
export const WF_SQUARE = 3;
export const WF_PULSE = 4;
export const WF_NOISE = 5;

const TWO_PI = Math.PI * 2;

/** PolyBLEP residual for a unit discontinuity at phase 0. */
export function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

export function naiveTriangle(t: number): number {
  return t < 0.5 ? -1 + 4 * t : 3 - 4 * t;
}

/**
 * Per-channel oscillator state. One voice has two of these per oscillator
 * (left/right) so stereo detune and phase offset are real phase differences.
 */
export class OscState {
  phase = 0;
  /** integrator state for the HQ triangle */
  tri = -1;

  setPhase(p: number): void {
    this.phase = p - Math.floor(p);
    this.tri = naiveTriangle(this.phase);
  }
}

/**
 * Render one sample and advance the phase.
 * `pw` is the pulse width for WF_PULSE (square is pw = 0.5).
 */
export function oscSample(s: OscState, wf: number, dt: number, hq: boolean, pw: number): number {
  const t = s.phase;
  let v: number;
  switch (wf) {
    case WF_SINE:
      v = Math.sin(TWO_PI * t);
      break;
    case WF_SAW:
      v = 2 * t - 1;
      if (hq) v -= polyBlep(t, dt);
      break;
    case WF_SQUARE:
    case WF_PULSE: {
      const w = wf === WF_SQUARE ? 0.5 : pw;
      v = t < w ? 1 : -1;
      if (hq) {
        v += polyBlep(t, dt);
        let t2 = t - w;
        if (t2 < 0) t2 += 1;
        v -= polyBlep(t2, dt);
      }
      // remove the DC offset of asymmetric pulses for cleaner gain staging
      v -= 2 * w - 1;
      break;
    }
    case WF_TRIANGLE: {
      if (hq) {
        let sq = t < 0.5 ? 1 : -1;
        sq += polyBlep(t, dt);
        let t2 = t - 0.5;
        if (t2 < 0) t2 += 1;
        sq -= polyBlep(t2, dt);
        // integrate: triangle slope is ±4 per cycle → ±4·dt per sample
        let tri = s.tri + 4 * dt * sq;
        // leak toward the ideal value to cancel numerical drift
        tri += (naiveTriangle(t) - tri) * 0.002;
        s.tri = tri;
        v = tri;
      } else {
        v = naiveTriangle(t);
      }
      break;
    }
    default:
      v = 0;
  }
  let p = t + dt;
  if (p >= 1) p -= Math.floor(p);
  s.phase = p;
  return v;
}

/** Fast xorshift32 white noise generator in [-1, 1). */
export class Noise {
  private state: number;
  constructor(seed = 0x1234567) {
    this.state = seed | 0 || 1;
  }
  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x;
    return (x | 0) / 2147483648;
  }
}

/** Waveform as a static shape for UI previews (no band-limiting). */
export function previewSample(wf: number, t: number, pw: number, noise: Noise): number {
  switch (wf) {
    case WF_SINE:
      return Math.sin(TWO_PI * t);
    case WF_TRIANGLE:
      return naiveTriangle(t);
    case WF_SAW:
      return 2 * t - 1;
    case WF_SQUARE:
      return t < 0.5 ? 1 : -1;
    case WF_PULSE:
      return t < pw ? 1 : -1;
    case WF_NOISE:
      return noise.next();
    default:
      return 0;
  }
}

/**
 * Block kernels: render `n` samples of one oscillator into `out` with the
 * waveform branch taken once per block instead of once per sample. Produces
 * exactly the same samples as calling oscSample() n times.
 */
/**
 * Band-limited (PolyBLEP) saw added straight into a stereo pair with gains:
 * the same samples as renderOscBlock(WF_SAW, hq) followed by a mix pass, in
 * one loop (unison stacks run many of these per voice).
 */
export function mixSawBlock(s: OscState, dt: number, outL: Float64Array, outR: Float64Array, gl: number, gr: number, n: number): void {
  let t = s.phase;
  for (let i = 0; i < n; i++) {
    let v = 2 * t - 1;
    if (t < dt) {
      const x = t / dt;
      v -= x + x - x * x - 1;
    } else if (t > 1 - dt) {
      const x = (t - 1) / dt;
      v -= x * x + x + x + 1;
    }
    outL[i] = (outL[i] as number) + v * gl;
    outR[i] = (outR[i] as number) + v * gr;
    t += dt;
    if (t >= 1) t -= 1;
  }
  s.phase = t;
}

export function renderOscBlock(s: OscState, wf: number, dt: number, hq: boolean, pw: number, out: Float64Array, n: number): void {
  let t = s.phase;
  switch (wf) {
    case WF_SINE:
      for (let i = 0; i < n; i++) {
        out[i] = Math.sin(TWO_PI * t);
        t += dt;
        if (t >= 1) t -= 1;
      }
      break;
    case WF_SAW:
      if (hq) {
        for (let i = 0; i < n; i++) {
          let v = 2 * t - 1;
          if (t < dt) {
            const x = t / dt;
            v -= x + x - x * x - 1;
          } else if (t > 1 - dt) {
            const x = (t - 1) / dt;
            v -= x * x + x + x + 1;
          }
          out[i] = v;
          t += dt;
          if (t >= 1) t -= 1;
        }
      } else {
        for (let i = 0; i < n; i++) {
          out[i] = 2 * t - 1;
          t += dt;
          if (t >= 1) t -= 1;
        }
      }
      break;
    case WF_SQUARE:
    case WF_PULSE: {
      const w = wf === WF_SQUARE ? 0.5 : pw;
      const dc = 2 * w - 1;
      for (let i = 0; i < n; i++) {
        let v = t < w ? 1 : -1;
        if (hq) {
          v += polyBlep(t, dt);
          let t2 = t - w;
          if (t2 < 0) t2 += 1;
          v -= polyBlep(t2, dt);
        }
        out[i] = v - dc;
        t += dt;
        if (t >= 1) t -= 1;
      }
      break;
    }
    case WF_TRIANGLE: {
      if (hq) {
        let tri = s.tri;
        const step = 4 * dt;
        for (let i = 0; i < n; i++) {
          let sq = t < 0.5 ? 1 : -1;
          sq += polyBlep(t, dt);
          let t2 = t - 0.5;
          if (t2 < 0) t2 += 1;
          sq -= polyBlep(t2, dt);
          tri += step * sq;
          tri += ((t < 0.5 ? -1 + 4 * t : 3 - 4 * t) - tri) * 0.002;
          out[i] = tri;
          t += dt;
          if (t >= 1) t -= 1;
        }
        s.tri = tri;
      } else {
        for (let i = 0; i < n; i++) {
          out[i] = t < 0.5 ? -1 + 4 * t : 3 - 4 * t;
          t += dt;
          if (t >= 1) t -= 1;
        }
      }
      break;
    }
    default:
      out.fill(0, 0, n);
  }
  s.phase = t;
}

export function renderNoiseBlock(noise: Noise, out: Float64Array, n: number): void {
  for (let i = 0; i < n; i++) out[i] = noise.next();
}
