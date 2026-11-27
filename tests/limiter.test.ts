import { describe, expect, it } from 'vitest';
import { LimiterCore } from '../src/audio/limiter/LimiterCore';
import { LIMITER_LOOKAHEADS, LIMITER_SPECS, createEffectSlot, defaultParams, effectTailSeconds, sanitizeEffect, FACTORY_EFFECT_PRESETS } from '../src/audio/effects/specs';
import { automatableParams } from '../src/project/automation';
import { modulatableEffectParams } from '../src/project/modulation';
import { createProject, createTrack } from '../src/project/defaults';
import { INSTRUMENTS } from '../src/instruments/definitions';

const SR = 48000;
const B = 128;
const db = (g: number) => 20 * Math.log10(g);

/** run a whole signal through a limiter in 128-sample blocks (like the worklet) */
function run(core: LimiterCore, l: Float32Array, r: Float32Array, ceiling: number, release: number): [Float32Array, Float32Array] {
  const ol = new Float32Array(l.length);
  const or = new Float32Array(r.length);
  for (let i = 0; i < l.length; i += B) {
    const n = Math.min(B, l.length - i);
    core.process(l.subarray(i, i + n), r.subarray(i, i + n), ol.subarray(i, i + n), or.subarray(i, i + n), n, ceiling, release);
  }
  return [ol, or];
}

/** a nasty test signal: silence, then hard-edged bursts, single-sample spikes and a hot sweep */
function transients(seconds: number): [Float32Array, Float32Array] {
  const n = Math.round(seconds * SR);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  let s = 0x9e3779b9;
  const rnd = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let x = 0;
    // a square burst (full scale, instant edges) every 250 ms, 20 ms long
    if (t % 0.25 > 0.1 && t % 0.25 < 0.12) x = (Math.floor(t * 2000) % 2 ? 1 : -1) * 1.0;
    // a hot sweep underneath (+6 dB over a −6 dB ceiling)
    x += 0.9 * Math.sin(2 * Math.PI * (60 + 4000 * t) * t) * (t > 0.5 ? 1 : 0);
    l[i] = x;
    r[i] = -0.7 * x;
  }
  // single-sample spikes up to +18 dB over the ceiling, one channel at a time
  for (let k = 0; k < 200; k++) {
    const i = Math.floor(rnd() * n);
    (k % 2 ? l : r)[i] = (rnd() < 0.5 ? -1 : 1) * (1 + rnd() * 3);
  }
  return [l, r];
}

describe('Limiter core (lookahead brickwall)', () => {
  for (const lookahead of [1.5, 3, 6]) {
    it(`no sample above the ceiling, fast transients included (lookahead ${lookahead} ms)`, () => {
      const core = new LimiterCore(SR);
      core.setLookahead(lookahead);
      const ceiling = 0.5; // −6 dBFS
      const [l, r] = transients(2);
      const [ol, or] = run(core, l, r, ceiling, 0.05);
      let peak = 0;
      for (const x of [ol, or]) for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i] as number));
      expect(peak).toBeLessThanOrEqual(ceiling * (1 + 1e-6));
      // the limiter caught every peak itself: the last-resort clamp never had real work
      expect(core.clamped).toBe(0);
      // and it really limited (this is not a quiet signal)
      expect(peak).toBeGreaterThan(ceiling * 0.99);
    });
  }

  it('below the ceiling it is transparent: the input, delayed by exactly the lookahead', () => {
    const core = new LimiterCore(SR);
    core.setLookahead(3);
    const d = Math.round(0.003 * SR);
    expect(core.latency).toBe(d);
    const n = SR / 2;
    const l = new Float32Array(n).map((_, i) => 0.4 * Math.sin(i * 0.031) + 0.2 * Math.sin(i * 0.0071));
    const r = new Float32Array(n).map((_, i) => 0.3 * Math.cos(i * 0.017));
    const [ol, or] = run(core, l, r, Math.pow(10, -1 / 20), 0.1);
    for (let i = 0; i < d; i++) expect(ol[i]).toBe(0);
    for (let i = d; i < n; i++) {
      if (ol[i] !== l[i - d] || or[i] !== r[i - d]) throw new Error(`sample ${i} differs`);
    }
  });

  it('the gain glides down before a peak (no jump) and recovers within the release time', () => {
    const release = 0.1;
    const core = new LimiterCore(SR);
    core.setLookahead(3);
    const d = core.latency;
    const ceiling = 0.25;
    // 0.3 s at full level (needs −12 dB), then a quiet level (0.1, no reduction needed) to read the gain off
    const loud = Math.round(0.3 * SR);
    const n = loud + SR;
    const x = new Float32Array(n).map((_, i) => (i < loud ? 1 : 0.1));
    const [out] = run(core, x, x, ceiling, release);
    const gainAt = (i: number) => (out[i] as number) / (x[i - d] as number);
    for (let i = 0; i < d; i++) expect(out[i]).toBe(0); // the delay line starts silent
    expect(gainAt(d)).toBeCloseTo(ceiling, 6); // the first loud sample comes out exactly at the ceiling
    // the reduction the loud part needed
    const peakGr = db(ceiling);
    expect(db(gainAt(loud + d - 1))).toBeCloseTo(peakGr, 3);
    // the release starts once the last loud sample has left the lookahead window; the attack
    // ramp (a W-sample average) shows it in the output gain up to W samples later
    const start = loud + 2 * d;
    const left = (t: number) => db(gainAt(start + Math.round(t * SR))) / peakGr; // share of the reduction (dB) still there
    expect(left(0)).toBeGreaterThan(0.9);
    // not instant: after a third of the release time about a fifth of the reduction is left
    expect(left(release / 3)).toBeGreaterThan(0.15);
    expect(left(release / 3)).toBeLessThan(0.4);
    expect(left(release)).toBeLessThan(0.05); // recovered (≤ 5 % of the reduction) within the release time
    expect(left(release)).toBeGreaterThan(0); // and smoothly, not with a jump to unity
  });

  it('the attack is a ramp as long as the lookahead, not a step', () => {
    const core = new LimiterCore(SR);
    core.setLookahead(3);
    const d = core.latency;
    const n = SR / 10;
    // quiet 0.1 at first, then one loud sample of 1.0 (needs gain 0.25 at a 0.25 ceiling)
    const x = new Float32Array(n).fill(0.1);
    const spike = 2000;
    x[spike] = 1;
    const [out] = run(core, x, x, 0.25, 0.05);
    const g = (i: number) => (out[i] as number) / (x[i - d] as number);
    // the gain falls over the d samples before the spike leaves the delay, in equal steps
    expect(g(spike - 1)).toBe(1);
    expect(g(spike + d)).toBeCloseTo(0.25, 6);
    let maxStep = 0;
    for (let i = spike - 1; i < spike + d; i++) maxStep = Math.max(maxStep, g(i) - g(i + 1));
    expect(maxStep).toBeLessThan((1 - 0.25) / d + 1e-9);
  });

  it('changing the lookahead changes the delay; the meter reports the lowest gain since its last read', () => {
    const core = new LimiterCore(SR);
    core.setLookahead(6);
    expect(core.latency).toBe(Math.round(0.006 * SR));
    core.setLookahead(1.5);
    expect(core.latency).toBe(Math.round(0.0015 * SR));
    const x = new Float32Array(SR / 10).fill(1);
    run(core, x, x, 0.5, 0.1);
    expect(db(core.takeMinGain())).toBeCloseTo(-6.02, 1);
    expect(core.takeMinGain()).toBe(1); // reset by the read
  });
});

describe('Limiter effect model', () => {
  it('defaults, specs and the declared tail', () => {
    const slot = createEffectSlot('limiter');
    const p = defaultParams('limiter');
    expect(slot.params).toEqual(p);
    expect(LIMITER_LOOKAHEADS.map((l) => l.value)).toContain(p.lookahead);
    // the tail is the delay it adds
    expect(effectTailSeconds(slot, 120)).toBeCloseTo(p.lookahead / 1000, 6);
    expect(LIMITER_SPECS.ceiling.max).toBe(0);
  });

  it('sanitizes saved slots: clamps knobs, snaps the lookahead to a choice', () => {
    const s = sanitizeEffect({ id: 'x', type: 'limiter', enabled: true, params: { drive: 99, ceiling: 3, release: -1, lookahead: 4.1 } });
    expect(s?.type).toBe('limiter');
    if (s?.type !== 'limiter') return;
    expect(s.params.drive).toBe(LIMITER_SPECS.drive.max);
    expect(s.params.ceiling).toBe(0);
    expect(s.params.release).toBe(LIMITER_SPECS.release.min);
    expect(LIMITER_LOOKAHEADS.map((l) => l.value)).toContain(s.params.lookahead);
  });

  it('factory presets cover master and bus use; drive, ceiling and release can be automated, drive sidechained', () => {
    const presets = FACTORY_EFFECT_PRESETS.filter((p) => p.type === 'limiter');
    expect(presets.length).toBeGreaterThanOrEqual(3);
    for (const p of presets) expect(sanitizeEffect({ type: 'limiter', params: p.params })?.params).toEqual(p.params);
    const p = createProject();
    const t = createTrack('instrument', 0, INSTRUMENTS.triosc.createConfig());
    const slot = createEffectSlot('limiter');
    t.effects = [slot];
    p.tracks = [t];
    expect(automatableParams(slot).map((x) => x.key)).toEqual(['drive', 'ceiling', 'release']);
    expect(modulatableEffectParams(t, slot.id).map((x) => x.key)).toEqual(['drive']);
  });
});
