/**
 * The Saturator's Lo-Fi stage (runs in an AudioWorklet; pure and testable):
 * sample-rate reduction (sample and hold at `rate` Hz — the aliasing is the
 * point) and bit-depth reduction (rounding to 2^(bits−1) steps per side).
 * Fractional bits and rates sweep smoothly, so both can be automated.
 */
export class CrushCore {
  private readonly sr: number;
  private phase = 1;
  private holdL = 0;
  private holdR = 0;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
  }

  process(inL: Float32Array | null, inR: Float32Array | null, outL: Float32Array, outR: Float32Array, bits: number, rate: number): void {
    const n = outL.length;
    if (!inL) {
      outL.fill(0);
      outR.fill(0);
      return;
    }
    const iR = inR ?? inL;
    const step = Math.min(1, Math.max(1e-4, rate / this.sr));
    const quant = bits < 15.9;
    const q = Math.pow(2, Math.max(1, bits) - 1);
    let phase = this.phase;
    let hl = this.holdL;
    let hr = this.holdR;
    for (let i = 0; i < n; i++) {
      phase += step;
      if (phase >= 1) {
        phase -= 1;
        hl = inL[i] as number;
        hr = iR[i] as number;
        if (quant) {
          hl = Math.round(hl * q) / q;
          hr = Math.round(hr * q) / q;
        }
      }
      outL[i] = hl;
      outR[i] = hr;
    }
    this.phase = phase;
    this.holdL = hl;
    this.holdR = hr;
  }
}
