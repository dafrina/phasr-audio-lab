import { describe, expect, it } from 'vitest';
import { PhaserCore, type PhaserFrameParams } from '../src/audio/phaser/PhaserCore';

const SR = 48000;
const BLOCK = 128;
const still = (o: Partial<PhaserFrameParams> = {}): PhaserFrameParams => ({ rate: 0.001, depth: 0, center: 1000, shift: 0, feedback: 0, stereo: 0, ...o });

/** run a mono signal through the core; returns the wet output */
function run(core: PhaserCore, x: Float32Array, p: PhaserFrameParams): Float32Array {
  const out = new Float32Array(x.length);
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  for (let i = 0; i + BLOCK <= x.length; i += BLOCK) {
    const blk = x.subarray(i, i + BLOCK);
    core.process(blk, blk, l, r, p);
    out.set(l, i);
  }
  return out;
}
const sine = (f: number, sec = 0.5) => Float32Array.from({ length: Math.round(SR * sec) }, (_, i) => Math.sin((2 * Math.PI * f * i) / SR));
const rms = (x: Float32Array, from = 0.2) => {
  let e = 0;
  const a = Math.round(from * x.length);
  for (let i = a; i < x.length; i++) e += (x[i] as number) ** 2;
  return Math.sqrt(e / (x.length - a));
};
/** 50/50 dry + wet, as the effect mixes it at Mix = 50 % */
const mixed = (x: Float32Array, w: Float32Array) => Float32Array.from(x, (v, i) => 0.5 * (v + (w[i] as number)));

describe('Phaser DSP', () => {
  it('the all-pass chain alone changes phase, not level', () => {
    for (const f of [100, 1000, 5000]) {
      const x = sine(f);
      const w = run(new PhaserCore(SR, 8), x, still());
      expect(rms(w) / rms(x)).toBeGreaterThan(0.98);
      expect(rms(w) / rms(x)).toBeLessThan(1.02);
    }
  });

  it('mixed with the dry signal it cuts notches: 2 stages → one notch at the centre', () => {
    const at = (f: number) => {
      const x = sine(f);
      return rms(mixed(x, run(new PhaserCore(SR, 2), x, still({ center: 1000 })))) / rms(x);
    };
    expect(at(1000)).toBeLessThan(0.05); // ≈ −26 dB or deeper at the notch
    expect(at(100)).toBeGreaterThan(0.9); // far below the notch: untouched
    expect(at(10000)).toBeGreaterThan(0.9);
  });

  it('more stages, more notches; the centre moves them', () => {
    const notchesBelow = (stages: number, center: number) => {
      // count dips across 50 Hz–15 kHz
      let n = 0;
      let prev = 1;
      let falling = false;
      for (let i = 0; i <= 60; i++) {
        const f = 50 * Math.pow(300, i / 60);
        const x = sine(f, 0.25);
        const g = rms(mixed(x, run(new PhaserCore(SR, stages), x, still({ center }))), 0.3) / rms(x, 0.3);
        if (g > prev && falling && prev < 0.5) n++;
        falling = g < prev;
        prev = g;
      }
      return n;
    };
    expect(notchesBelow(8, 1000)).toBeGreaterThan(notchesBelow(2, 1000));
  });

  it('stays stable at full feedback, positive and negative', () => {
    for (const fb of [0.95, -0.95]) {
      const x = Float32Array.from({ length: SR }, () => Math.random() * 2 - 1);
      const w = run(new PhaserCore(SR, 12), x, still({ feedback: fb, depth: 3, rate: 2 }));
      expect(w.every((v) => Number.isFinite(v) && Math.abs(v) < 50)).toBe(true);
    }
  });

  it('skips work once its input has been silent for a while (and still outputs silence)', () => {
    const core = new PhaserCore(SR, 6);
    const l = new Float32Array(BLOCK);
    const r = new Float32Array(BLOCK);
    const zero = new Float32Array(BLOCK);
    let skipped = false;
    for (let i = 0; i < (5 * SR) / BLOCK; i++) skipped = !core.process(zero, zero, l, r, still({ feedback: 0.9 }));
    expect(skipped).toBe(true);
    expect(l.every((v) => v === 0)).toBe(true);
    // and it wakes up on sound
    const x = sine(500, BLOCK / SR);
    expect(core.process(x, x, l, r, still())).toBe(true);
  });
});

describe('Phaser settings', () => {
  it('sanitizes saved settings, syncs to tempo, and offers the right automation / sidechain targets', async () => {
    const { createEffectSlot, sanitizeEffect, phaserLfoHz } = await import('../src/audio/effects/specs');
    const { automatableParams } = await import('../src/project/automation');
    const { createTrack } = await import('../src/project/defaults');
    const { isModulatable } = await import('../src/project/modulation');
    const s = createEffectSlot('phaser');
    if (s.type !== 'phaser') throw new Error('type');
    expect(s.params).toMatchObject({ stages: 6, mix: 0.5, sync: true });
    const bad = sanitizeEffect({ id: 'x', type: 'phaser', enabled: true, params: { stages: 7, center: 99999, feedback: 3, division: 5 } });
    expect(bad).toMatchObject({ params: { stages: 6, center: 6000, feedback: 0.9, division: 8 } });
    expect(phaserLfoHz({ ...s.params, sync: true, division: 2 }, 120)).toBeCloseTo(1);
    expect(automatableParams(s).map((p) => p.key)).toEqual(['center', 'depth', 'feedback', 'mix']);
    const t = { ...createTrack('audio', 0), effects: [s] };
    expect(isModulatable(t, { kind: 'fx', slotId: s.id, param: 'center' })).toBe(true);
    expect(isModulatable(t, { kind: 'fx', slotId: s.id, param: 'mix' })).toBe(true);
  });
});
