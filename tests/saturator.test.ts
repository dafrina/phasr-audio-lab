import { describe, expect, it } from 'vitest';
import { SAT_RANGE, saturate, saturatorCurve, saturatorGain, saturatorHarmonics } from '../src/audio/saturator/shapes';
import type { SaturatorMode } from '../src/project/types';

const MODES: SaturatorMode[] = ['tape', 'tube', 'overdrive', 'hard', 'fold'];

describe('Saturator shapes', () => {
  it('stay within ±1 over the whole curve and pass quiet signals almost unchanged', () => {
    for (const m of MODES) {
      const c = saturatorCurve(m, 4097);
      expect(c.every((v) => Number.isFinite(v) && Math.abs(v) <= 1.0001), m).toBe(true);
      // the middle of the curve: x = 0 → 0 (no offset at rest)
      expect(Math.abs(c[2048] as number), m).toBeLessThan(1e-6);
      // small-signal slope ≈ 1 … 1.6 (no big jump in level when the drive is low)
      const slope = saturate(m, 1e-3) / 1e-3;
      expect(slope, m).toBeGreaterThan(0.95);
      expect(slope, m).toBeLessThan(1.7);
    }
    expect(SAT_RANGE).toBeGreaterThanOrEqual(63);
  });

  it('symmetric shapes add odd harmonics only; tube adds even ones', () => {
    const tape = saturatorHarmonics('tape', 18);
    expect(tape[2]).toBeGreaterThan(-40); // 3rd
    expect(tape[1]).toBeLessThan(-100); // 2nd: none
    const tube = saturatorHarmonics('tube', 18);
    expect(tube[1]).toBeGreaterThan(-40); // 2nd: there
  });

  it('more drive, more harmonics', () => {
    for (const m of MODES) {
      const lo = saturatorHarmonics(m, 3);
      const hi = saturatorHarmonics(m, 24);
      const sum = (h: number[]) => h.slice(1).reduce((a, d) => a + Math.pow(10, d / 20), 0);
      expect(sum(hi), m).toBeGreaterThan(sum(lo));
    }
  });

  it("the static estimate (auto gain's starting point) is close at typical instrument levels", () => {
    const rms = (amp: number, m: SaturatorMode, d: number) => {
      const g = Math.pow(10, d / 20);
      let s = 0;
      for (let i = 0; i < 480; i++) s += saturate(m, amp * g * Math.sin((2 * Math.PI * i) / 480)) ** 2;
      return Math.sqrt(s / 480) / saturatorGain(m, d);
    };
    for (const m of MODES) {
      // instruments hit the effect with peaks around −8 dBFS; the adaptive auto gain does the rest
      for (const amp of [0.3, 0.4, 0.55]) {
        const lv = [0, 12, 24, 36].map((d) => 20 * Math.log10(rms(amp, m, d) / (amp / Math.SQRT2)));
        expect(Math.max(...lv) - Math.min(...lv), `${m} at ${amp}`).toBeLessThan(5);
      }
      // and the uncompensated gain really grows with drive (so compensation has work to do)
      expect(saturatorGain(m, 24), m).toBeGreaterThan(saturatorGain(m, 0));
    }
  });
});

describe('Saturator settings', () => {
  it('has defaults, presets, validation, automation and sidechain targets', async () => {
    const { createEffectSlot, sanitizeEffect, FACTORY_EFFECT_PRESETS, EFFECT_LABELS } = await import('../src/audio/effects/specs');
    const { automatableParams } = await import('../src/project/automation');
    const { modulatableEffectParams } = await import('../src/project/modulation');
    const s = createEffectSlot('saturator');
    if (s.type !== 'saturator') throw new Error('type');
    expect(EFFECT_LABELS.saturator).toBe('Saturator');
    expect(s.params.autoGain).toBe(true);
    expect(FACTORY_EFFECT_PRESETS.filter((p) => p.type === 'saturator').length).toBeGreaterThanOrEqual(5);
    const bad = sanitizeEffect({ id: 'x', type: 'saturator', enabled: true, params: { mode: 'laser', drive: 99, tone: 5, output: -99, mix: 2 } });
    if (bad?.type !== 'saturator') throw new Error('type');
    expect(bad.params).toEqual({ mode: 'tape', drive: 36, tone: 1000, output: -24, mix: 1, autoGain: true });
    expect(automatableParams(s).map((p) => p.key)).toEqual(['drive', 'tone', 'output', 'mix']);
    const track = { effects: [s] } as unknown as Parameters<typeof modulatableEffectParams>[0];
    expect(modulatableEffectParams(track, s.id).map((p) => p.key)).toEqual(['output', 'mix']);
  });
});

describe('Saturator auto gain (AutoGainCore)', () => {
  const SR = 48000;
  const B = 128;
  /** 1 s of a sine (ref) and its saturated version (wet) through the core; output rms / ref rms in dB */
  async function run(refAmp: number, wetGain: number, auto = true) {
    const { AutoGainCore } = await import('../src/audio/saturator/AutoGainCore');
    const core = new AutoGainCore(SR);
    const ref = new Float32Array(B);
    const wet = new Float32Array(B);
    const oL = new Float32Array(B);
    const oR = new Float32Array(B);
    let sIn = 0;
    let sOut = 0;
    for (let b = 0; b < (2 * SR) / B; b++) {
      for (let i = 0; i < B; i++) {
        const t = (b * B + i) / SR;
        ref[i] = refAmp * Math.sin(2 * Math.PI * 220 * t);
        wet[i] = Math.tanh((ref[i] as number) * wetGain);
      }
      core.process(wet, wet, ref, ref, oL, oR, auto, 1);
      if (b * B > SR) for (let i = 0; i < B; i++) {
        sIn += (ref[i] as number) ** 2;
        sOut += (oL[i] as number) ** 2;
      }
    }
    return 10 * Math.log10(sOut / sIn);
  }

  it('matches the dry level for quiet and loud input at any drive', async () => {
    for (const amp of [0.02, 0.1, 0.5]) for (const g of [1, 8, 60]) {
      expect(Math.abs(await run(amp, g)), `amp ${amp} drive ×${g}`).toBeLessThan(0.5);
    }
  });

  it('passes the saturated signal unchanged with auto gain off', async () => {
    const db = await run(0.5, 8, false);
    expect(db).toBeGreaterThan(3);
  });

  it('holds its gain through silence', async () => {
    const { AutoGainCore } = await import('../src/audio/saturator/AutoGainCore');
    const core = new AutoGainCore(SR);
    const x = new Float32Array(B).map((_, i) => 0.3 * Math.sin(i / 3));
    const w = x.map((v) => v * 4);
    const z = new Float32Array(B);
    const o = new Float32Array(B);
    for (let b = 0; b < 800; b++) core.process(w, w, x, x, o, o, true, 1);
    const g = core.gain;
    for (let b = 0; b < 2000; b++) core.process(z, z, z, z, o, o, true, 1);
    expect(core.gain).toBeCloseTo(g, 2);
    expect(g).toBeCloseTo(0.25, 1);
  });
});
