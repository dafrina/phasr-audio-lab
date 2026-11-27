import { describe, expect, it } from 'vitest';
import { RoomCore, type RoomFrameParams } from '../src/audio/room/RoomCore';

const SR = 48000;
const B = 128;
const P = (o: Partial<RoomFrameParams> = {}): RoomFrameParams => ({ decay: 1.6, decayShift: 0, size: 1, tone: 6000, ...o });

/** impulse in, `sec` seconds of wet out (left, right) */
function impulse(core: RoomCore, p: RoomFrameParams, sec: number): [Float32Array, Float32Array] {
  const n = Math.ceil((sec * SR) / B) * B;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const inL = new Float32Array(B);
  const inR = new Float32Array(B);
  const oL = new Float32Array(B);
  const oR = new Float32Array(B);
  for (let b = 0; b * B < n; b++) {
    inL.fill(0);
    inR.fill(0);
    if (b === 0) {
      inL[0] = 1;
      inR[0] = 1;
    }
    core.process(inL, inR, oL, oR, p);
    L.set(oL, b * B);
    R.set(oR, b * B);
  }
  return [L, R];
}

/** T60 from the energy decay curve (Schroeder), fitted between −5 and −35 dB */
function t60(x: Float32Array): number {
  const e = new Float64Array(x.length);
  let acc = 0;
  for (let i = x.length - 1; i >= 0; i--) {
    acc += (x[i] as number) ** 2;
    e[i] = acc;
  }
  const db = (i: number) => 10 * Math.log10((e[i] as number) / (e[0] as number));
  let i5 = 0;
  while (db(i5) > -5) i5++;
  let i35 = i5;
  while (i35 < x.length - 1 && db(i35) > -35) i35++;
  return (((i35 - i5) / SR) * 60) / 30;
}

const energy = (x: Float32Array) => x.reduce((a, v) => a + v * v, 0);

describe('Reverb Lite (RoomCore)', () => {
  it('rings for the decay it is set to', () => {
    for (const decay of [0.5, 1.6, 4]) {
      const [l] = impulse(new RoomCore(SR), P({ decay }), decay * 1.6 + 0.3);
      const m = t60(l);
      expect(m, `decay ${decay}`).toBeGreaterThan(decay * 0.8);
      expect(m, `decay ${decay}`).toBeLessThan(decay * 1.2);
    }
  });

  it('a sidechained decay shift shortens the tail', () => {
    const [long] = impulse(new RoomCore(SR), P({ decay: 3 }), 4);
    const [short] = impulse(new RoomCore(SR), P({ decay: 3, decayShift: -2.4 }), 4);
    expect(t60(short)).toBeLessThan(t60(long) * 0.35);
  });

  it('gets gently louder with a longer decay, like Reverb Pro (not by the tail length alone)', () => {
    const e = [0.6, 2, 8].map((decay) => energy(impulse(new RoomCore(SR), P({ decay }), decay * 1.3 + 0.2)[0]));
    expect(e[1]).toBeGreaterThan(e[0] as number);
    expect(e[2]).toBeGreaterThan(e[1] as number);
    // an un-normalised network would grow with the decay itself (≈ 11 dB here)
    expect(10 * Math.log10((e[2] as number) / (e[0] as number))).toBeLessThan(10);
  });

  it('is stereo: left and right tails differ', () => {
    const [l, r] = impulse(new RoomCore(SR), P(), 1);
    let d = 0;
    for (let i = 0; i < l.length; i++) d += ((l[i] as number) - (r[i] as number)) ** 2;
    expect(d / energy(l)).toBeGreaterThan(0.3);
  });

  it('a lower tone darkens the tail', () => {
    const hf = (x: Float32Array) => {
      let s = 0;
      for (let i = 1; i < x.length; i++) s += ((x[i] as number) - (x[i - 1] as number)) ** 2;
      return s / energy(x);
    };
    const bright = hf(impulse(new RoomCore(SR), P({ tone: 14000 }), 1.5)[0]);
    const dark = hf(impulse(new RoomCore(SR), P({ tone: 1200 }), 1.5)[0]);
    expect(dark).toBeLessThan(bright * 0.5);
  });

  it('sleeps once input and tail are silent, and wakes on sound', () => {
    const core = new RoomCore(SR);
    const z = new Float32Array(B);
    const o = new Float32Array(B);
    const o2 = new Float32Array(B);
    expect(core.process(z, z, o, o2, P())).toBe(false);
    const x = new Float32Array(B).fill(0.5);
    expect(core.process(x, x, o, o2, P({ decay: 0.3 }))).toBe(true);
    expect(core.sleeping).toBe(false);
    let blocks = 0;
    while (!core.sleeping && blocks < 3000) {
      core.process(z, z, o, o2, P({ decay: 0.3 }));
      blocks++;
    }
    expect(core.sleeping).toBe(true);
    expect(blocks * B).toBeLessThan(SR * 2);
    expect(core.process(x, x, o, o2, P({ decay: 0.3 }))).toBe(true);
  });

  it('stays finite with extreme settings', () => {
    const core = new RoomCore(SR);
    const x = new Float32Array(B).map((_, i) => (i % 2 ? 1 : -1));
    const oL = new Float32Array(B);
    const oR = new Float32Array(B);
    for (let b = 0; b < 2000; b++) core.process(x, x, oL, oR, P({ decay: 20, size: 1.6, tone: 20000 }));
    expect(oL.every((v) => Number.isFinite(v) && Math.abs(v) < 50)).toBe(true);
  });
});

describe('Reverb Lite settings', () => {
  it('has defaults, presets, validation, automation and sidechain targets', async () => {
    const { createEffectSlot, sanitizeEffect, effectTailSeconds, FACTORY_EFFECT_PRESETS, EFFECT_LABELS } = await import('../src/audio/effects/specs');
    const { automatableParams } = await import('../src/project/automation');
    const { modulatableEffectParams } = await import('../src/project/modulation');
    const s = createEffectSlot('room');
    if (s.type !== 'room') throw new Error('type');
    expect(EFFECT_LABELS.room).toBe('Reverb Lite');
    expect(FACTORY_EFFECT_PRESETS.filter((p) => p.type === 'room').length).toBeGreaterThanOrEqual(5);
    const bad = sanitizeEffect({ id: 'x', type: 'room', enabled: true, params: { decay: 999, size: -3, tone: 'x', preDelay: 9 } });
    expect(bad?.type).toBe('room');
    if (bad?.type !== 'room') throw new Error('type');
    expect(bad.params.decay).toBe(12);
    expect(bad.params.size).toBe(0.4);
    expect(bad.params.tone).toBe(6000);
    expect(bad.params.preDelay).toBe(0.25);
    expect(effectTailSeconds(s, 120)).toBeCloseTo(s.params.decay + s.params.preDelay + 0.05);
    expect(automatableParams(s).map((p) => p.key)).toEqual(['decay', 'tone', 'preDelay', 'mix']);
    const track = { effects: [s] } as unknown as Parameters<typeof modulatableEffectParams>[0];
    expect(modulatableEffectParams(track, s.id).map((p) => p.key)).toEqual(['mix', 'decay', 'preDelay']);
  });
});
