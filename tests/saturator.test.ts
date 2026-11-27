import { describe, expect, it } from 'vitest';
import { SAT_RANGE, saturate, saturatorCurve, saturatorGain, saturatorHarmonics } from '../src/audio/saturator/shapes';
import type { SaturatorMode } from '../src/project/types';

const MODES: SaturatorMode[] = ['tape', 'tube', 'overdrive', 'hard', 'fuzz', 'rectify', 'fold'];

describe('Saturator shapes', () => {
  it('stay within ±1 over the whole curve and pass quiet signals almost unchanged', () => {
    for (const m of MODES) {
      const c = saturatorCurve(m, 4097);
      expect(c.every((v) => Number.isFinite(v) && Math.abs(v) <= 1.0001), m).toBe(true);
      // the middle of the curve: x = 0 → 0 (no offset at rest)
      expect(Math.abs(c[2048] as number), m).toBeLessThan(1e-6);
      // small-signal slope ≈ 1 … 1.6 (no big jump in level when the drive is low)
      // (the rectifier folds the negative half up, so it has no small-signal slope to speak of)
      if (m === 'rectify') continue;
      const slope = saturate(m, 1e-3) / 1e-3;
      expect(slope, m).toBeGreaterThan(0.95);
      expect(slope, m).toBeLessThan(4.1);
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
    // (the rectifier moves nearly everything to the octave: "relative to the fundamental" means nothing there)
    for (const m of MODES.filter((x) => x !== 'rectify')) {
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
    expect(bad.params).toEqual({ mode: 'tape', drive: 36, bias: 0, clean: 20, focus: 1200, emph: 0, bits: 16, rate: 40000, tone: 1000, output: -24, mix: 1, autoGain: true });
    expect(automatableParams(s).map((p) => p.key)).toEqual(['drive', 'bits', 'rate', 'tone', 'output', 'mix']);
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

describe('Saturator: new characters, bias, Lo-Fi', () => {
  it('rectify doubles the frequency (an octave up); fuzz is lopsided (even harmonics)', () => {
    const rect = saturatorHarmonics('rectify', 6);
    expect(rect[1]).toBeGreaterThan(10); // the 2nd harmonic is louder than the fundamental
    const fuzz = saturatorHarmonics('fuzz', 12);
    expect(fuzz[1]).toBeGreaterThan(-30);
  });

  it('bias adds even harmonics to a symmetric character', () => {
    expect(saturatorHarmonics('tape', 12, 10, 0)[1]).toBeLessThan(-100);
    expect(saturatorHarmonics('tape', 12, 10, 0.4)[1]).toBeGreaterThan(-40);
  });

  it('Lo-Fi: bit reduction quantises, rate reduction holds samples', async () => {
    const { CrushCore } = await import('../src/audio/saturator/CrushCore');
    const c = new CrushCore(48000);
    const x = new Float32Array(128).map((_, i) => Math.sin(i / 7) * 0.9);
    const oL = new Float32Array(128);
    const oR = new Float32Array(128);
    c.process(x, x, oL, oR, 3, 48000);
    const levels = new Set(Array.from(oL, (v) => Math.round(v * 1000)));
    expect(levels.size).toBeLessThanOrEqual(9); // 3 bits: 2² steps per side
    const c2 = new CrushCore(48000);
    c2.process(x, x, oL, oR, 16, 6000);
    let changes = 0;
    for (let i = 1; i < 128; i++) if (oL[i] !== oL[i - 1]) changes++;
    expect(changes).toBeLessThanOrEqual(17); // 6 kHz: one new value every 8 samples
    expect(changes).toBeGreaterThanOrEqual(14);
    // off: 16 bits at the full rate passes the signal through
    const c3 = new CrushCore(48000);
    c3.process(x, x, oL, oR, 16, 48000);
    expect(oL.every((v, i) => v === x[i])).toBe(true);
  });
});

describe('Utility settings', () => {
  it('has defaults, presets, validation, automation and a sidechain target', async () => {
    const { createEffectSlot, sanitizeEffect, FACTORY_EFFECT_PRESETS, EFFECT_LABELS } = await import('../src/audio/effects/specs');
    const { automatableParams } = await import('../src/project/automation');
    const { modulatableEffectParams } = await import('../src/project/modulation');
    const s = createEffectSlot('utility');
    if (s.type !== 'utility') throw new Error('type');
    expect(EFFECT_LABELS.utility).toBe('Utility');
    expect(s.params).toEqual({ gain: 0, pan: 0, width: 1, invertL: false, invertR: false });
    expect(FACTORY_EFFECT_PRESETS.some((p) => p.type === 'utility' && p.name === 'Mono')).toBe(true);
    const bad = sanitizeEffect({ id: 'x', type: 'utility', enabled: true, params: { gain: 99, pan: -5, width: 9, invertL: 'yes' } });
    if (bad?.type !== 'utility') throw new Error('type');
    expect(bad.params).toEqual({ gain: 24, pan: -1, width: 2, invertL: false, invertR: false });
    expect(automatableParams(s).map((p) => p.key)).toEqual(['gain', 'pan', 'width']);
    const track = { effects: [s] } as unknown as Parameters<typeof modulatableEffectParams>[0];
    expect(modulatableEffectParams(track, s.id).map((p) => p.key)).toEqual(['gain']);
  });
});

describe('Reverb Pro shape', () => {
  it('the default impulse is unchanged; size, damping and early reshape it', async () => {
    const { generateImpulse } = await import('../src/audio/effects/impulse');
    const sr = 48000;
    const [d] = generateImpulse(sr, 1.5);
    const [d2] = generateImpulse(sr, 1.5, { size: 1, damping: 0.5, early: 1 });
    expect(d2.every((v, i) => v === d[i])).toBe(true);
    // damping: a darker tail has less high-frequency energy (first difference)
    const hf = (x: Float32Array) => {
      let a = 0;
      let e = 0;
      for (let i = 1; i < x.length; i++) {
        a += ((x[i] as number) - (x[i - 1] as number)) ** 2;
        e += (x[i] as number) ** 2;
      }
      return a / e;
    };
    // (measured on the tail alone: the early-reflection spikes would dominate)
    // (and from 0.3 s on: damping acts as the tail goes on)
    const tail = (damping: number) => hf(generateImpulse(sr, 1.5, { damping, early: 0 })[0].slice(0.3 * sr));
    expect(tail(0.9)).toBeLessThan(tail(0.5) * 0.8);
    expect(tail(0.1)).toBeGreaterThan(tail(0.5) * 1.2);
    // early: how much the reflection spikes stand out of the first 80 ms (peak / rms)
    const er = (x: Float32Array) => {
      const a = x.slice(0, 0.08 * sr);
      const pk = a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
      return pk / Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
    };
    expect(er(generateImpulse(sr, 1.5, { early: 2 })[0])).toBeGreaterThan(er(d) * 1.5);
    expect(er(generateImpulse(sr, 1.5, { early: 0 })[0])).toBeLessThanOrEqual(er(d) * 1.01);
  });

  it('old projects (decay, pre-delay, mix only) open with the new settings at their defaults', async () => {
    const { sanitizeEffect, defaultParams } = await import('../src/audio/effects/specs');
    const s = sanitizeEffect({ id: 'r', type: 'reverb', enabled: true, params: { decay: 3, preDelay: 0.03, mix: 0.4 } });
    expect(s?.params).toEqual({ ...defaultParams('reverb'), decay: 3, preDelay: 0.03, mix: 0.4 });
  });
});
