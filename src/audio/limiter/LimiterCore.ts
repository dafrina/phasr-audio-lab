/**
 * Lookahead brickwall limiter (pure DSP, no allocation while processing; runs
 * in the phasr-limiter AudioWorklet and in Node tests).
 *
 * Per sample (stereo-linked): the gain a sample needs to stay at the ceiling,
 * g = min(1, ceiling / max(|L|, |R|)), goes through
 *  1. a running minimum over the lookahead window (W samples): every sample
 *     inside the window pulls the gain down to what it needs;
 *  2. the release: the gain rises back towards that minimum exponentially,
 *     95 % of the way (in dB, any amount) within the release time, and drops
 *     instantly when the minimum does;
 *  3. a moving average over W samples: the attack, a linear ramp as long as
 *     the lookahead, so the gain glides down instead of jumping.
 * The audio is delayed by W − 1 samples (the lookahead). A peak at sample p
 * pulls steps 1–2 below its need for samples p … p + W − 1, so the average at
 * p + W − 1 — the moment p leaves the delay — is below it too: the output
 * never exceeds the ceiling by construction (sample peaks; between samples a
 * reconstructed waveform can overshoot slightly, as with any sample-peak
 * limiter). A final clamp only catches float rounding; `clamped` counts the
 * samples it had to move by more than that, so tests can show it does no work.
 */

const RELEASE_TIME_CONSTANTS = 3; // e^-3 ≈ 5 % left after the release time

export class LimiterCore {
  private readonly sr: number;
  private readonly maxW: number;
  private w = 1;
  // delay line (W − 1 samples of each channel) and the box filter's history, as rings
  private readonly dl: Float32Array;
  private readonly dr: Float32Array;
  private readonly box: Float64Array;
  private pos = 0;
  private sum = 0;
  // monotonic deque for the running minimum: gains and the sample index they expire at
  private readonly qv: Float64Array;
  private readonly qt: Float64Array;
  private qHead = 0;
  private qLen = 0;
  private n = 0;
  private env = 1;
  private minGain = 1;
  /** samples the final clamp had to pull back by more than float rounding (should stay 0) */
  clamped = 0;

  constructor(sampleRate: number, maxLookaheadMs = 10) {
    this.sr = sampleRate;
    this.maxW = Math.max(2, Math.round((maxLookaheadMs * sampleRate) / 1000) + 1);
    this.dl = new Float32Array(this.maxW);
    this.dr = new Float32Array(this.maxW);
    this.box = new Float64Array(this.maxW);
    this.qv = new Float64Array(this.maxW);
    this.qt = new Float64Array(this.maxW);
    this.setLookahead(3);
  }

  /** the delay the limiter adds, in samples */
  get latency(): number {
    return this.w - 1;
  }

  /** Lookahead in ms. A change restarts the limiter (its delay line starts silent). */
  setLookahead(ms: number): void {
    const w = Math.min(this.maxW, Math.max(2, Math.round((ms * this.sr) / 1000) + 1));
    if (w === this.w) return;
    this.w = w;
    this.reset();
  }

  reset(): void {
    this.dl.fill(0);
    this.dr.fill(0);
    this.box.fill(1);
    this.sum = this.w;
    this.pos = 0;
    this.qHead = 0;
    this.qLen = 0;
    this.n = 0;
    this.env = 1;
  }

  /** The lowest gain applied since the last call (1 = no reduction), for a meter. */
  takeMinGain(): number {
    const g = this.minGain;
    this.minGain = 1;
    return g;
  }

  /**
   * Limit `count` samples. `inR` / `outR` may be null (mono). `ceiling` is linear
   * (> 0), `release` in seconds.
   */
  process(inL: Float32Array | null, inR: Float32Array | null, outL: Float32Array, outR: Float32Array | null, count: number, ceiling: number, release: number): void {
    const w = this.w;
    const d = w - 1;
    const cap = this.maxW;
    const rel = 1 - Math.exp(-RELEASE_TIME_CONSTANTS / (Math.max(0.0005, release) * this.sr));
    const ceil = Math.max(1e-6, ceiling);
    const limit = ceil * (1 + 1e-6);
    const { dl, dr, box, qv, qt } = this;
    let { pos, sum, qHead, qLen, n, env, minGain } = this;
    for (let i = 0; i < count; i++) {
      const xl = inL ? (inL[i] as number) : 0;
      const xr = inR ? (inR[i] as number) : xl;
      const peak = Math.max(Math.abs(xl), Math.abs(xr));
      const need = peak > ceil ? ceil / peak : 1;
      // 1. running minimum over the window: drop larger gains from the back, expired ones from the front
      while (qLen > 0 && (qv[(qHead + qLen - 1) % cap] as number) >= need) qLen--;
      const back = (qHead + qLen) % cap;
      qv[back] = need;
      qt[back] = n + w;
      qLen++;
      while ((qt[qHead] as number) <= n) {
        qHead = (qHead + 1) % cap;
        qLen--;
      }
      const hold = qv[qHead] as number;
      // 2. release towards the held minimum; instant attack
      env = hold < env ? hold : env + (hold - env) * rel;
      // 3. attack ramp: the average of the last W gains
      const slot = pos % w;
      sum += env - (box[slot] as number);
      box[slot] = env;
      const g = sum / w;
      if (g < minGain) minGain = g;
      // the delayed sample leaves with that gain
      const dpos = pos % cap;
      const rd = (pos - d + cap * 2) % cap;
      const yl0 = (dl[rd] as number) * g;
      const yr0 = (dr[rd] as number) * g;
      dl[dpos] = xl;
      dr[dpos] = xr;
      let yl = yl0;
      let yr = yr0;
      if (yl > ceil || yl < -ceil) {
        if (Math.abs(yl) > limit) this.clamped++;
        yl = yl > 0 ? ceil : -ceil;
      }
      if (yr > ceil || yr < -ceil) {
        if (Math.abs(yr) > limit) this.clamped++;
        yr = yr > 0 ? ceil : -ceil;
      }
      outL[i] = yl;
      if (outR) outR[i] = yr;
      pos = (pos + 1) % (cap * w);
      n++;
    }
    // the running sum, exact again (float error must not pile up over hours)
    sum = 0;
    for (let k = 0; k < w; k++) sum += box[k] as number;
    // keep the counters small (n only matters relative to the deque's expiry times)
    if (n > 1e12) {
      for (let k = 0; k < qLen; k++) {
        const j = (qHead + k) % cap;
        qt[j] = (qt[j] as number) - n;
      }
      n = 0;
    }
    this.pos = pos;
    this.sum = sum;
    this.qHead = qHead;
    this.qLen = qLen;
    this.n = n;
    this.env = env;
    this.minGain = minGain;
  }
}
