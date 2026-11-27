import { describe, expect, it } from 'vitest';
import { cellPeaks, findTrigger, freqToUnit, logBinRanges, peakOf, spectrogramPalette, unitToFreq } from '../src/ui/analyzer/analysis';

const SR = 48000;

describe('analyser arithmetic', () => {
  it('log axis: 20 Hz … 20 kHz, 1 kHz a decade in from each third', () => {
    expect(freqToUnit(20)).toBe(0);
    expect(freqToUnit(20000)).toBeCloseTo(1, 12);
    expect(freqToUnit(632.46)).toBeCloseTo(0.5, 4);
    expect(unitToFreq(freqToUnit(1234))).toBeCloseTo(1234, 6);
  });

  it('bin ranges cover the axis in order; a tone lands in the cell of its frequency', () => {
    const bins = 4096; // fftSize 8192
    const cells = 300;
    const r = logBinRanges(cells, bins, SR);
    for (let c = 1; c <= cells; c++) expect(r[c]).toBeGreaterThanOrEqual(r[c - 1]!);
    expect(r[cells]).toBeLessThanOrEqual(bins - 1);
    // a 1 kHz tone: a single loud bin
    const data = new Float32Array(bins).fill(-100);
    const bin = Math.round(1000 / (SR / 2 / bins));
    data[bin] = -6;
    const out = new Float32Array(cells);
    cellPeaks(data, r, out);
    const loud = [...out].map((v, i) => [v, i] as const).filter(([v]) => v > -50).map(([, i]) => i);
    expect(loud.length).toBeGreaterThan(0);
    // the cells that show it are where 1 kHz is on the axis
    for (const c of loud) expect(Math.abs(c / cells - freqToUnit(1000))).toBeLessThan(0.02);
    // every cell reads at least one bin: nothing left at -Infinity in the bass
    expect(out.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('scope trigger: a periodic wave starts at the same phase whatever the buffer offset', () => {
    const f = 220;
    const n = 4096;
    const phases: number[] = [];
    for (const offset of [0, 37, 101, 333, 1000]) {
      const buf = new Float32Array(n).map((_, i) => 0.5 * Math.sin((2 * Math.PI * f * (i + offset)) / SR) + 0.2 * Math.sin((2 * Math.PI * 3 * f * (i + offset)) / SR));
      const t = findTrigger(buf, 0, n / 2, 0.05 * peakOf(buf));
      expect(t).toBeGreaterThanOrEqual(0);
      phases.push(((t + offset) * f) / SR % 1);
    }
    // all triggers within one sample of the same phase
    for (const p of phases) expect(Math.min(Math.abs(p - phases[0]!), 1 - Math.abs(p - phases[0]!))).toBeLessThan(f / SR + 1e-9);
  });

  it('scope trigger: small noise around zero does not trigger; no crossing → −1', () => {
    const noise = new Float32Array(2048).map((_, i) => 0.001 * Math.sin(i * 1.7));
    expect(findTrigger(noise, 0, 2048, 0.01)).toBe(-1);
    expect(findTrigger(new Float32Array(512).fill(0.3), 0, 512, 0.01)).toBe(-1);
  });

  it('palette: 256 opaque colours, dark at the bottom, bright at the top', () => {
    const p = spectrogramPalette();
    expect(p.length).toBe(256);
    const lum = (c: number) => (c & 255) + ((c >>> 8) & 255) + ((c >>> 16) & 255);
    expect(p.every((c) => c >>> 24 === 255)).toBe(true);
    expect(lum(p[0]!)).toBeLessThan(40);
    expect(lum(p[255]!)).toBeGreaterThan(650);
  });
});
