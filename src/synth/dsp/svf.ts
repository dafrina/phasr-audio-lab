/**
 * Topology-preserving-transform state variable filter (after Andrew Simper's
 * "linear trapezoidal SVF"). It stays stable and click-free under fast cutoff
 * modulation, which matters for filter envelopes and LFO sweeps, and gives
 * low-, high- and band-pass outputs from one structure.
 */
export const FILTER_LP = 0;
export const FILTER_HP = 1;
export const FILTER_BP = 2;

export class SvfCoefs {
  a1 = 0;
  a2 = 0;
  a3 = 0;
  k = 2;

  /** resonance 0..~0.95 → damping k from 2 (no resonance) down to 0.1 */
  set(cutoff: number, resonance: number, sampleRate: number): void {
    const fc = Math.min(cutoff, sampleRate * 0.49);
    const g = Math.tan((Math.PI * Math.max(10, fc)) / sampleRate);
    const k = Math.max(0.1, 2 - 2 * resonance);
    this.k = k;
    this.a1 = 1 / (1 + g * (g + k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
}

export class Svf {
  ic1 = 0;
  ic2 = 0;

  reset(): void {
    this.ic1 = 0;
    this.ic2 = 0;
  }

  process(x: number, c: SvfCoefs, mode: number): number {
    const v3 = x - this.ic2;
    const v1 = c.a1 * this.ic1 + c.a2 * v3;
    const v2 = this.ic2 + c.a2 * this.ic1 + c.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    if (mode === FILTER_LP) return v2;
    if (mode === FILTER_HP) return x - c.k * v1 - v2;
    // band-pass normalized to unity gain at the center frequency
    return c.k * v1;
  }
}
