/**
 * Saturator auto gain (runs in an AudioWorklet; pure and testable in Node).
 *
 * A fixed make-up gain can't keep the level: how much a saturator adds
 * depends on how hot the signal going in is (a quiet piano barely clips, a
 * loud synth clips all the time). So this follows both levels: the dry
 * signal (reference, aligned with the oversampler's latency) and the
 * saturated one, as slow RMS (≈ 0.3 s), and scales the saturated signal so
 * the two match. Slow enough to keep the saturator's own short-term
 * squashing (that is the sound); fast enough to follow the drive knob.
 *
 * In silence the gain holds. Until both levels are known it starts from the
 * static estimate (`guess`), so switching on doesn't jump.
 */

/** energy floor (≈ −80 dBFS): below this a level counts as silence */
const FLOOR = 1e-8;
const MIN_GAIN = 1 / 128;
const MAX_GAIN = 8;

export class AutoGainCore {
  private readonly a: number;
  private readonly gStep: number;
  private eRef = 0;
  private eWet = 0;
  private g = -1;

  constructor(sampleRate: number, tau = 0.3) {
    this.a = Math.exp(-1 / (tau * sampleRate));
    // the applied gain glides towards its target over ~40 ms (no zipper)
    this.gStep = 1 - Math.exp(-128 / (0.04 * sampleRate));
  }

  /** current gain (for tests and the display) */
  get gain(): number {
    return this.g;
  }

  process(
    wetL: Float32Array | null,
    wetR: Float32Array | null,
    refL: Float32Array | null,
    refR: Float32Array | null,
    outL: Float32Array,
    outR: Float32Array,
    auto: boolean,
    guess: number,
  ): void {
    const n = outL.length;
    if (!wetL) {
      outL.fill(0);
      outR.fill(0);
      return;
    }
    const wR = wetR ?? wetL;
    if (!auto) {
      outL.set(wetL);
      outR.set(wR);
      this.g = -1;
      return;
    }
    if (this.g < 0) this.g = Math.min(MAX_GAIN, Math.max(MIN_GAIN, guess));
    const a = this.a;
    const b = 1 - a;
    let eRef = this.eRef;
    let eWet = this.eWet;
    const rL = refL;
    const rR = refR ?? refL;
    for (let i = 0; i < n; i++) {
      const x0 = rL ? (rL[i] as number) : 0;
      const x1 = rR ? (rR[i] as number) : 0;
      const y0 = wetL[i] as number;
      const y1 = wR[i] as number;
      eRef = a * eRef + b * 0.5 * (x0 * x0 + x1 * x1);
      eWet = a * eWet + b * 0.5 * (y0 * y0 + y1 * y1);
    }
    this.eRef = eRef;
    this.eWet = eWet;
    // aim: saturated RMS = dry RMS (hold while either side is silent)
    let target = this.g;
    if (eRef > FLOOR && eWet > FLOOR) target = Math.min(MAX_GAIN, Math.max(MIN_GAIN, Math.sqrt(eRef / eWet)));
    const g0 = this.g;
    const g1 = g0 + (target - g0) * this.gStep;
    this.g = g1;
    const d = (g1 - g0) / n;
    let g = g0;
    for (let i = 0; i < n; i++) {
      g += d;
      outL[i] = (wetL[i] as number) * g;
      outR[i] = (wR[i] as number) * g;
    }
  }
}
