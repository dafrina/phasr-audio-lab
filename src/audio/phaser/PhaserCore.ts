/**
 * Phaser DSP (runs inside an AudioWorklet; pure and testable in Node).
 *
 * Per channel: a chain of first-order all-pass stages whose break frequency
 * an LFO sweeps (in octaves around a centre), with feedback from the chain's
 * output back to its input — that resonance is what makes a phaser "sing".
 * The node outputs only the phased (wet) signal; mixing it with the dry
 * signal (50 / 50 for the classic deep notches) happens outside, like every
 * other effect. The right channel's LFO runs ahead by up to half a cycle
 * (Stereo) for a swirl across the speakers.
 *
 * Silent input with a settled chain is skipped (no work while idle).
 */

export const PHASER_STAGES = [2, 4, 6, 8, 12] as const;
const MAX_STAGES = 12;
/** coefficients are recomputed this often (the sweep is slow; tan() per sample is not needed) */
const CONTROL = 16;

export interface PhaserFrameParams {
  /** LFO Hz */
  rate: number;
  /** sweep, octaves either side of the centre */
  depth: number;
  /** Hz */
  center: number;
  /** extra octaves on the centre (sidechain / automation) */
  shift: number;
  /** −0.95..0.95 */
  feedback: number;
  /** 0..1 → right LFO phase offset 0..180° */
  stereo: number;
}

export class PhaserCore {
  private readonly sr: number;
  private stages = 6;
  private phase = 0;
  /** all-pass state per channel: x1 (input z⁻¹) and y1 (output z⁻¹) for each stage */
  private readonly x1 = [new Float64Array(MAX_STAGES), new Float64Array(MAX_STAGES)];
  private readonly y1 = [new Float64Array(MAX_STAGES), new Float64Array(MAX_STAGES)];
  private readonly fb = new Float64Array(2);
  private readonly coef = new Float64Array(2);
  private quiet = 0;

  constructor(sampleRate: number, stages = 6) {
    this.sr = sampleRate;
    this.setStages(stages);
  }

  setStages(n: number): void {
    const s = PHASER_STAGES.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a), 6);
    this.stages = s;
  }

  /** LFO value −1..1 for a phase 0..1 (sine) */
  private static lfo(ph: number): number {
    return Math.sin(2 * Math.PI * ph);
  }

  /** first-order all-pass coefficient for break frequency f */
  private a(f: number): number {
    const t = Math.tan((Math.PI * Math.min(this.sr * 0.45, Math.max(20, f))) / this.sr);
    return (t - 1) / (t + 1);
  }

  /**
   * Process one block. `inL/inR` may be null (no input connected). Writes the
   * wet signal into outL/outR. Returns false when the block was skipped as silent.
   */
  process(inL: Float32Array | null, inR: Float32Array | null, outL: Float32Array, outR: Float32Array, p: PhaserFrameParams): boolean {
    const n = outL.length;
    // idle: silent input and a settled chain → silence without work
    let loud = false;
    if (inL) for (let i = 0; i < n && !loud; i++) loud = Math.abs(inL[i] as number) > 1e-7;
    if (inR && !loud) for (let i = 0; i < n && !loud; i++) loud = Math.abs(inR[i] as number) > 1e-7;
    if (!loud) {
      if (this.quiet > 4 * this.sr) {
        outL.fill(0);
        outR.fill(0);
        this.phase = (this.phase + (p.rate * n) / this.sr) % 1;
        return false;
      }
      this.quiet += n;
    } else this.quiet = 0;

    const stages = this.stages;
    const fb = Math.max(-0.95, Math.min(0.95, p.feedback));
    const inc = p.rate / this.sr;
    const off = Math.max(0, Math.min(1, p.stereo)) * 0.5;
    const ins = [inL ?? inR, inR ?? inL];
    const outs = [outL, outR];
    for (let i0 = 0; i0 < n; i0 += CONTROL) {
      const end = Math.min(n, i0 + CONTROL);
      for (let c = 0; c < 2; c++) {
        const ph = (this.phase + (c === 1 ? off : 0)) % 1;
        const f = p.center * Math.pow(2, p.shift + p.depth * PhaserCore.lfo(ph));
        this.coef[c] = this.a(f);
      }
      for (let c = 0; c < 2; c++) {
        const x1 = this.x1[c] as Float64Array;
        const y1 = this.y1[c] as Float64Array;
        const a = this.coef[c] as number;
        const src = ins[c];
        const dst = outs[c] as Float32Array;
        let last = this.fb[c] as number;
        for (let i = i0; i < end; i++) {
          let x = (src ? (src[i] as number) : 0) + fb * last;
          for (let s = 0; s < stages; s++) {
            // y[n] = a·x[n] + x[n−1] − a·y[n−1]
            const y = a * x + (x1[s] as number) - a * (y1[s] as number);
            x1[s] = x;
            y1[s] = y;
            x = y;
          }
          // (flush the feedback state's denormal tail to zero)
          last = Math.abs(x) < 1e-25 ? 0 : x;
          dst[i] = x;
        }
        this.fb[c] = last;
      }
      this.phase = (this.phase + inc * (end - i0)) % 1;
    }
    return true;
  }
}
