/**
 * Keyforge realism tests: instead of comparing against reference samples,
 * these measure the rendered audio and check the physical behaviour each
 * engine is supposed to model (inharmonic partials, decay laws, dampers,
 * pickup non-linearity, drawbar levels, rotor speeds, filter sweeps …).
 */
import { describe, expect, it } from 'vitest';
import { KeysCore } from '../src/keys/dsp/KeysCore';
import { KeysSynth } from '../src/keys/dsp/KeysSynth';
import { TINE_MODE_2 } from '../src/keys/dsp/epiano';
import { DRAWBAR_SEMITONES, drawbarGain, wheelFor } from '../src/keys/dsp/organ';
import { inharmonicityB, partialFrequency, pianoFundamental } from '../src/keys/dsp/piano';
import { KEYS_ENGINES, KEYS_ENGINE_TYPES, defaultKeysParams, sanitizeKeysParams, type KeysConfigData, type KeysEngineType } from '../src/keys/params';
import { KEYS_PRESETS, keysPreset } from '../src/keys/presets';
import { centroid, db, energyAbove, envelopeDb, hasBadSamples, mono, peak, peakNear, renderKeys, rms, slice, spectrum, toneTrack, type ScoreEvent } from './helpers/analysis';

const SR = 48000;

function cfg(engine: KeysEngineType, over: Record<string, number> = {}): KeysConfigData {
  return { engine, params: { ...defaultKeysParams(engine), ...over } };
}
function presetCfg(name: string, over: Record<string, number> = {}): KeysConfigData {
  const p = keysPreset(name);
  if (!p) throw new Error(name);
  return { engine: p.engine, params: { ...p.params, ...over } };
}
const hit = (note: number, vel: number, t = 0, off?: number, id = 1): ScoreEvent[] => [
  { t, type: 'on', id, note, vel },
  ...(off !== undefined ? [{ t: off, type: 'off' as const, id }] : []),
];
/** least-squares slope (dB per second) of an envelope in dB sampled every `dt` */
function slope(env: number[], dt: number): number {
  const n = env.length;
  const mx = ((n - 1) * dt) / 2;
  const my = env.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  env.forEach((y, i) => {
    num += (i * dt - mx) * (y - my);
    den += (i * dt - mx) ** 2;
  });
  return num / den;
}
/** max deviation (dB) of an envelope from its own moving average: wobble (beating), not slow curvature */
function roughness(env: number[]): number {
  const half = 5;
  let worst = 0;
  for (let i = half; i < env.length - half; i++) {
    let sum = 0;
    for (let j = i - half; j <= i + half; j++) sum += env[j] as number;
    worst = Math.max(worst, Math.abs((env[i] as number) - sum / (2 * half + 1)));
  }
  return worst;
}

// ---------------------------------------------------------------------------

describe('Keyforge parameters & presets', () => {
  it('every preset only uses known parameters within range', () => {
    for (const p of KEYS_PRESETS) {
      const specs = KEYS_ENGINES[p.engine].params;
      expect(Object.keys(p.params).sort()).toEqual(specs.map((s) => s.key).sort());
      for (const s of specs) {
        const v = p.params[s.key] as number;
        expect(v, `${p.name}.${s.key}`).toBeGreaterThanOrEqual(s.min);
        expect(v, `${p.name}.${s.key}`).toBeLessThanOrEqual(s.max);
      }
    }
    // every engine has at least two presets
    for (const e of KEYS_ENGINE_TYPES) expect(KEYS_PRESETS.filter((p) => p.engine === e).length).toBeGreaterThanOrEqual(2);
  });

  it('sanitize clamps, defaults and drops unknown keys', () => {
    const s = sanitizeKeysParams('piano', { brightness: 9, sustain: 'x', bogus: 1 });
    expect(s.brightness).toBe(1);
    expect(s.sustain).toBe(defaultKeysParams('piano').sustain);
    expect('bogus' in s).toBe(false);
  });

  it('all presets render finite, bounded audio and free their voices after release', () => {
    for (const p of KEYS_PRESETS) {
      const synth = new KeysSynth(SR, { engine: p.engine, params: { ...p.params } });
      const score: ScoreEvent[] = [48, 55, 60, 64, 67].flatMap((n, i) => hit(n, 1, 0.005 * i, 1.5, i + 1));
      const [L, R] = renderKeys({ engine: p.engine, params: p.params }, score, 2, SR, synth);
      expect(hasBadSamples(L, R), p.name).toBe(false);
      const pk = Math.max(peak(L), peak(R));
      expect(pk, `${p.name} peak`).toBeLessThan(1);
      expect(pk, `${p.name} peak`).toBeGreaterThan(0.05);
      // let tails ring out (pads have long releases)
      renderKeys({ engine: p.engine, params: p.params }, [], 10, SR, synth);
      expect(synth.activeVoices(), `${p.name} voices`).toBe(0);
    }
  }, 60_000);

  it('rendering is deterministic', () => {
    const score = [...hit(60, 0.8, 0, 0.5), ...hit(64, 0.6, 0.1, 0.5, 2)];
    for (const e of KEYS_ENGINE_TYPES) {
      const [a] = renderKeys(cfg(e), score, 1, SR);
      const [b] = renderKeys(cfg(e), score, 1, SR);
      expect(a).toEqual(b);
    }
  });
});

describe('Keyforge piano — string physics', () => {
  it('partials follow the stiff-string inharmonicity law', () => {
    const note = 36;
    // (Metal off: phantom partials sit right next to the partials measured here)
    const [L, R] = renderKeys(cfg('piano', { unison: 0, metal: 0 }), hit(note, 0.9), 2.2, SR);
    const sp = spectrum(slice(mono(L, R), SR, 0.15, 2.15), SR, 1 << 17);
    const f1 = pianoFundamental(note, 1);
    const B = inharmonicityB(note, 1);
    for (const k of [1, 2, 3, 5, 8, 12, 16]) {
      const expected = partialFrequency(f1, k, B);
      const m = peakNear(sp, expected, f1 * 0.2);
      expect(Math.abs(m.f - expected), `partial ${k}`).toBeLessThan(expected * 0.0012);
    }
    // the 16th partial is measurably sharp of 16·f1 (≈ 13 cents for C2)
    const m16 = peakNear(sp, partialFrequency(f1, 16, B), f1 * 0.2).f;
    const m1 = peakNear(sp, f1, f1 * 0.2).f;
    expect(1200 * Math.log2(m16 / (16 * m1))).toBeGreaterThan(8);
  });

  it('A4 is tuned to 440 Hz and the treble is stretched sharp', () => {
    const [L, R] = renderKeys(cfg('piano', { unison: 0 }), hit(69, 0.7), 1.5, SR);
    const f = peakNear(spectrum(slice(mono(L, R), SR, 0.1, 1.5), SR, 1 << 17), 440, 20).f;
    expect(Math.abs(1200 * Math.log2(f / 440))).toBeLessThan(1);
    expect(pianoFundamental(100, 1)).toBeGreaterThan(midiHz(100) * Math.pow(2, 10 / 1200));
    expect(pianoFundamental(28, 1)).toBeLessThan(midiHz(28));
  });

  it('bass notes sustain much longer than treble notes', () => {
    const rate = (note: number) => {
      const [L, R] = renderKeys(cfg('piano'), hit(note, 0.8), 4, SR);
      return slope(envelopeDb(slice(mono(L, R), SR, 1.5, 3.5), SR, 0.1), 0.1);
    };
    const bass = rate(36);
    const mid = rate(60);
    const treble = rate(84);
    expect(bass).toBeLessThan(0);
    // aftersound T60 ≈ 60/|slope|: bass ≥ 10 s, mid in between, treble only a few seconds
    expect(60 / -bass).toBeGreaterThan(10);
    expect(-mid).toBeGreaterThan(-bass);
    expect(-treble).toBeGreaterThan(-mid * 1.5);
    expect(60 / -treble).toBeLessThan(6);
  });

  it('high partials decay faster than low ones (spectrum darkens over time)', () => {
    const note = 48;
    const [L, R] = renderKeys(cfg('piano', { unison: 0 }), hit(note, 1), 3, SR);
    const m = mono(L, R);
    const f1 = pianoFundamental(note, 1);
    const B = inharmonicityB(note, 1);
    const drop = (k: number) => {
      const tr = toneTrack(m, SR, partialFrequency(f1, k, B), 0.1);
      return db(tr[2] as number) - db(tr[25] as number);
    };
    expect(drop(16)).toBeGreaterThan(drop(2) + 10);
    const early = centroid(spectrum(slice(m, SR, 0.02, 0.3), SR));
    const late = centroid(spectrum(slice(m, SR, 2, 2.3), SR));
    expect(late).toBeLessThan(early * 0.75);
  });

  it('shows the double decay of coupled strings (fast prompt sound, slow aftersound)', () => {
    const [L, R] = renderKeys(cfg('piano'), hit(60, 0.8), 4, SR);
    const m = mono(L, R);
    const prompt = slope(envelopeDb(slice(m, SR, 0.03, 0.4), SR, 0.03), 0.03);
    const after = slope(envelopeDb(slice(m, SR, 1.5, 3.5), SR, 0.1), 0.1);
    expect(prompt).toBeLessThan(after * 1.8);
  });

  it('detuned unison strings beat; a single tuned string decays smoothly', () => {
    const note = 60;
    const f = partialFrequency(pianoFundamental(note, 1), 3, inharmonicityB(note, 1));
    const track = (unison: number) => {
      const [L, R] = renderKeys(cfg('piano', { unison }), hit(note, 0.8), 5, SR);
      return toneTrack(slice(mono(L, R), SR, 1, 5), SR, f, 0.05).map(db);
    };
    const smooth = roughness(track(0));
    expect(smooth).toBeLessThan(1.5);
    expect(roughness(track(5))).toBeGreaterThan(Math.max(2, smooth + 1));
  });

  it('harder strikes are brighter, not just louder', () => {
    const c = (vel: number) => {
      const [L, R] = renderKeys(cfg('piano'), hit(60, vel), 0.6, SR);
      return spectrum(slice(mono(L, R), SR, 0.01, 0.5), SR);
    };
    const soft = c(0.25);
    const hard = c(1);
    expect(centroid(hard)).toBeGreaterThan(centroid(soft) * 1.3);
    expect(energyAbove(hard, 2000)).toBeGreaterThan(energyAbove(soft, 2000) * 3);
  });

  it('the lowest fundamentals are weak compared to their overtones (small soundboard radiation)', () => {
    const note = 21;
    const [L, R] = renderKeys(cfg('piano'), hit(note, 0.8), 1.2, SR);
    const sp = spectrum(slice(mono(L, R), SR, 0.05, 1.2), SR, 1 << 17);
    const f1 = pianoFundamental(note, 1);
    const B = inharmonicityB(note, 1);
    expect(peakNear(sp, f1, 2).amp).toBeLessThan(peakNear(sp, partialFrequency(f1, 4, B), 3).amp * 0.5);
  });

  it('dampers stop released notes; the top keys have no dampers', () => {
    const after = (note: number, release: number | undefined) => {
      const [L, R] = renderKeys(cfg('piano'), hit(note, 0.8, 0, release), 1.6, SR);
      return db(rms(slice(mono(L, R), SR, 1.1, 1.6)));
    };
    expect(after(60, 0.4)).toBeLessThan(after(60, undefined) - 30);
    expect(Math.abs(after(96, 0.4) - after(96, undefined))).toBeLessThan(2);
  });

  it('the sustain pedal keeps released notes ringing and adds sympathetic resonance', () => {
    const score = (pedal: boolean): ScoreEvent[] => [...(pedal ? [{ t: 0, type: 'sustain' as const, on: true }] : []), ...hit(55, 0.8, 0.01, 0.4)];
    const [hl, hr] = renderKeys(cfg('piano'), hit(55, 0.8, 0.01), 2, SR);
    const [pl, pr] = renderKeys(cfg('piano'), score(true), 2, SR);
    const held = db(rms(slice(mono(hl, hr), SR, 1.2, 2)));
    const pedal = db(rms(slice(mono(pl, pr), SR, 1.2, 2)));
    expect(Math.abs(pedal - held)).toBeLessThan(3);
    // sympathetic strings: with the pedal down the C-family combs ring along
    const [a, b] = renderKeys(cfg('piano', { resonance: 0 }), score(true), 2, SR);
    const [c, d] = renderKeys(cfg('piano', { resonance: 1 }), score(true), 2, SR);
    const diff = new Float32Array(a.length);
    const ma = mono(a, b);
    const mc = mono(c, d);
    for (let i = 0; i < diff.length; i++) diff[i] = (mc[i] as number) - (ma[i] as number);
    expect(db(rms(slice(diff, SR, 1.2, 2)))).toBeGreaterThan(db(rms(slice(ma, SR, 1.2, 2))) - 30);
  });

  it('has a realistically bright, wide sound across the range (not dull, not mono)', () => {
    const energyDb = (x: number) => 10 * Math.log10(Math.max(x, 1e-30));
    for (const [note, minAbove2k] of [[48, -24], [60, -22], [72, -16]] as const) {
      const [L, R] = renderKeys(cfg('piano', { room: 0 }), hit(note, 0.8), 0.6, SR);
      const body = spectrum(slice(mono(L, R), SR, 0.1, 0.5), SR);
      // energy above 2 kHz relative to the whole note, after the attack
      expect(energyDb(energyAbove(body, 2000)), `note ${note}`).toBeGreaterThan(minAbove2k);
      let side = 0;
      let mid = 0;
      for (let i = 0; i < L.length; i++) {
        side += ((L[i] as number) - (R[i] as number)) ** 2;
        mid += ((L[i] as number) + (R[i] as number)) ** 2;
      }
      const width = energyDb(side / mid);
      expect(width, `note ${note} width`).toBeGreaterThan(-24);
      expect(width, `note ${note} width`).toBeLessThan(-6);
    }
  });

  it('the soundboard (wood) and the key action (knock) are clearly part of the sound', () => {
    const share = (note: number, over: Record<string, number>, from: number, to: number) => {
      const [a, b] = renderKeys(cfg('piano', { room: 0 }), hit(note, 0.75), to + 0.05, SR);
      const [c, d] = renderKeys(cfg('piano', { room: 0, ...over }), hit(note, 0.75), to + 0.05, SR);
      const full = mono(a, b);
      const without = mono(c, d);
      const diff = Float32Array.from(full, (x, i) => x - (without[i] as number));
      return 20 * Math.log10(rms(slice(diff, SR, from, to)) / rms(slice(full, SR, from, to)));
    };
    expect(share(60, { body: 0 }, 0.1, 1)).toBeGreaterThan(-18);
    expect(share(96, { hammerNoise: 0 }, 0, 0.04)).toBeGreaterThan(-18);
  });

  it('treble notes ring with their overtones instead of plucking away', () => {
    const note = 96;
    const [L, R] = renderKeys(cfg('piano', { room: 0 }), hit(note, 0.8), 1, SR);
    const m = mono(L, R);
    // overall: well under 20 dB lost in the first half second (a pluck loses more)
    expect(db(rms(slice(m, SR, 0.005, 0.05))) - db(rms(slice(m, SR, 0.45, 0.55)))).toBeLessThan(18);
    // the 2nd and 3rd partials are still clearly there after half a second
    const f1 = pianoFundamental(note, 1);
    const B = inharmonicityB(note, 1);
    for (const k of [2, 3]) {
      const tr = toneTrack(m, SR, partialFrequency(f1, k, B), 0.05);
      expect(db(tr[1] as number) - db(tr[12] as number), `partial ${k}`).toBeLessThan(35);
    }
    // a crisp attack: real energy above 5 kHz in the first 30 ms
    expect(energyAbove(spectrum(slice(m, SR, 0, 0.03), SR), 5000)).toBeGreaterThan(0.02);
  });

  it('hard strikes start a few cents sharp and settle (tension modulation)', () => {
    const note = 40;
    const f8 = partialFrequency(pianoFundamental(note, 1), 8, inharmonicityB(note, 1));
    const pitch = (vel: number, from: number, to: number) => {
      // string physics only: no soundboard/knock modes next to the measured partial
      const [L, R] = renderKeys(cfg('piano', { unison: 0, room: 0, metal: 0, body: 0, hammerNoise: 0 }), hit(note, vel), to + 0.01, SR);
      return peakNear(spectrum(slice(mono(L, R), SR, from, to), SR, 1 << 18), f8, 15).f;
    };
    const glide = 1200 * Math.log2(pitch(1, 0.005, 0.06) / pitch(1, 0.6, 0.9));
    expect(glide).toBeGreaterThan(1);
    expect(glide).toBeLessThan(15);
    // soft notes barely move
    expect(Math.abs(1200 * Math.log2(pitch(0.2, 0.005, 0.06) / pitch(0.2, 0.6, 0.9)))).toBeLessThan(glide / 3);
  });

  it('the room adds an ambient tail', () => {
    const tail = (room: number) => {
      const [L, R] = renderKeys(cfg('piano', { room, resonance: 0 }), hit(60, 0.9, 0, 0.3), 1, SR);
      return db(rms(slice(mono(L, R), SR, 0.5, 0.8)));
    };
    expect(tail(1)).toBeGreaterThan(tail(0) + 6);
  });

  it('restriking a sounding note reuses its string', () => {
    const synth = new KeysSynth(SR, cfg('piano'));
    renderKeys(cfg('piano'), [...hit(60, 0.5, 0, 0.3), ...hit(60, 0.9, 0.5, undefined, 2)], 0.8, SR, synth);
    expect(synth.activeVoices()).toBe(1);
  });
});

describe('Keyforge electric piano — tine & pickup', () => {
  const ep = (over: Record<string, number> = {}) => cfg('epiano', { tremDepth: 0, drive: 0, tone: 16000, ...over });

  it('hard hits bark: pickup harmonics grow faster than the fundamental', () => {
    const note = 57;
    const f0 = 220;
    /** harmonic distortion: energy of H2…H6 relative to the fundamental */
    const thd = (vel: number) => {
      const [L, R] = renderKeys(ep(), hit(note, vel), 0.8, SR);
      const sp = spectrum(slice(mono(L, R), SR, 0.3, 0.8), SR, 1 << 16);
      const h1 = peakNear(sp, f0, 6).amp;
      let e = 0;
      for (let k = 2; k <= 6; k++) e += peakNear(sp, k * f0, 6).amp ** 2;
      return Math.sqrt(e) / h1;
    };
    expect(db(thd(1)) - db(thd(0.25))).toBeGreaterThan(8);
    // and with Bark at zero the tine stays much cleaner
    const [L, R] = renderKeys(ep({ bark: 0 }), hit(note, 1), 0.8, SR);
    const sp = spectrum(slice(mono(L, R), SR, 0.3, 0.8), SR, 1 << 16);
    expect(db(peakNear(sp, 2 * f0, 6).amp / peakNear(sp, f0, 6).amp)).toBeLessThan(-20);
  });

  it('the bell partial of the tine rings briefly while the fundamental sustains', () => {
    const note = 57;
    const [L, R] = renderKeys(ep({ bell: 1 }), hit(note, 0.9), 1.2, SR);
    const m = mono(L, R);
    const bell = toneTrack(m, SR, 220 * TINE_MODE_2, 0.04).map(db);
    const fund = toneTrack(m, SR, 220, 0.04).map(db);
    expect((bell[0] as number) - (bell[20] as number)).toBeGreaterThan(30);
    expect((fund[0] as number) - (fund[20] as number)).toBeLessThan(8);
  });

  it('stereo tremolo swings the sound between the channels at the set rate', () => {
    const [L, R] = renderKeys(ep({ tremDepth: 1, tremRate: 4 }), hit(60, 0.8), 2.5, SR);
    const el = envelopeDb(slice(L, SR, 0.5, 2.5), SR, 0.01);
    const er = envelopeDb(slice(R, SR, 0.5, 2.5), SR, 0.01);
    // opposite phase: L−R level difference oscillates strongly …
    const d = el.map((v, i) => v - (er[i] as number));
    expect(Math.max(...d) - Math.min(...d)).toBeGreaterThan(12);
    // … crossing zero twice per cycle: 4 Hz over 2 s ≈ 8 cycles
    let crossings = 0;
    for (let i = 1; i < d.length; i++) if (Math.sign(d[i] as number) !== Math.sign(d[i - 1] as number)) crossings++;
    expect(crossings / 2).toBeGreaterThanOrEqual(7);
    expect(crossings / 2).toBeLessThanOrEqual(9);
  });

  it('the damper stops a released tine quickly', () => {
    const [L, R] = renderKeys(ep(), hit(60, 0.8, 0, 0.3), 1, SR);
    expect(db(rms(slice(mono(L, R), SR, 0.7, 1)))).toBeLessThan(db(rms(slice(mono(L, R), SR, 0.05, 0.3))) - 50);
  });
});

describe('Keyforge organ — tonewheels, percussion, rotary', () => {
  const dry = (over: Record<string, number> = {}) =>
    cfg('organ', { db0: 0, db1: 0, db2: 0, db3: 0, db4: 0, db5: 0, db6: 0, db7: 0, db8: 0, perc: 0, click: 0, drive: 0, rotorMix: 0, vibrato: 0, ...over });

  it('drawbar steps are 3 dB apart', () => {
    const [L, R] = renderKeys(dry({ db2: 8, db3: 6 }), hit(60, 1), 1, SR);
    const sp = spectrum(slice(mono(L, R), SR, 0.2, 1), SR, 1 << 16);
    const f = 261.63;
    const diff = db(peakNear(sp, 2 * f, 5).amp) - db(peakNear(sp, f, 5).amp);
    expect(diff).toBeGreaterThan(-7);
    expect(diff).toBeLessThan(-5);
    expect(db(drawbarGain(5))).toBeCloseTo(-9, 5);
  });

  it('drawbars use tempered tonewheels and fold back at the top of the generator', () => {
    expect(DRAWBAR_SEMITONES).toEqual([-12, 7, 0, 12, 19, 24, 28, 31, 36]);
    expect(wheelFor(96, 8)).toBe(132 - 24); // 1′ on C7 folds down an octave
    expect(wheelFor(24, 0)).toBe(24); // 16′ on C1 folds up
    expect(wheelFor(60, 4)).toBe(79);
  });

  it('keys sharing a tonewheel are phase locked (amplitudes add, no beating)', () => {
    const reg = dry({ db2: 8, db3: 8 });
    const [L, R] = renderKeys(reg, [...hit(60, 1), ...hit(72, 1, 0, undefined, 2)], 1.5, SR);
    const m = mono(L, R);
    const c5 = toneTrack(slice(m, SR, 0.2, 1.5), SR, 523.25, 0.05).map(db);
    expect(Math.max(...c5) - Math.min(...c5)).toBeLessThan(0.5);
    const [l1, r1] = renderKeys(reg, hit(72, 1), 1.5, SR);
    const single = db(peakNear(spectrum(slice(mono(l1, r1), SR, 0.2, 1.5), SR, 1 << 16), 523.25, 5).amp);
    expect((c5[5] as number) - single).toBeCloseTo(6.02, 0);
  });

  it('percussion is single-triggered and decays', () => {
    const reg = dry({ db2: 8, perc: 1, percHarm: 3, percDecay: 0.2, percLevel: 1 });
    const third = 261.63 * 2.9966;
    const legato = [...hit(60, 1, 0, 1.2), ...hit(64, 1, 0.6, 1.2, 2)];
    const [L, R] = renderKeys(reg, legato, 1.4, SR);
    const tr = toneTrack(mono(L, R), SR, third, 0.05).map(db);
    expect((tr[0] as number) - (tr[10] as number)).toBeGreaterThan(20);
    // E4's 2⅔′ wheel at 0.6 s gets no new percussion while C4 is still held
    const e3 = toneTrack(slice(mono(L, R), SR, 0.6, 1.2), SR, 329.63 * 2.9966, 0.05).map(db);
    expect(Math.max(...e3)).toBeLessThan((tr[0] as number) - 20);
  });

  it('key click adds a burst of high-frequency energy at the onset', () => {
    const onset = (click: number) => {
      const [L, R] = renderKeys(dry({ db2: 8, click }), hit(60, 1), 0.05, SR);
      return energyAbove(spectrum(slice(mono(L, R), SR, 0, 0.02), SR), 3000);
    };
    expect(onset(1)).toBeGreaterThan(onset(0) * 10);
  });

  it('the rotary horn spins at ~6.7 Hz in fast mode and ~0.8 Hz in slow mode', () => {
    const modRate = (rotor: number) => {
      const [L] = renderKeys(dry({ db3: 8, rotorMix: 1, rotor }), hit(72, 1), 5, SR);
      const env = envelopeDb(slice(L, SR, 2, 5), SR, 0.005);
      const mean = env.reduce((a, b) => a + b, 0) / env.length;
      const x = Float32Array.from(env, (v) => v - mean);
      const sp = spectrum(x, 200, 1 << 14);
      let best = 1;
      for (let i = 1; i < sp.mag.length; i++) if ((sp.mag[i] as number) > (sp.mag[best] as number)) best = i;
      return best * sp.binHz;
    };
    const fast = modRate(1);
    expect(fast).toBeGreaterThan(5.8);
    expect(fast).toBeLessThan(7.5);
    expect(modRate(0)).toBeLessThan(1.5);
  });
});

describe('Keyforge analog — pads & techno', () => {
  it('unison voices spread in stereo; a single centred voice is mono', () => {
    const side = (over: Record<string, number>) => {
      const [L, R] = renderKeys(cfg('analog', { ensemble: 0, noise: 0, ...over }), hit(48, 0.8), 1, SR);
      const s = new Float32Array(L.length);
      for (let i = 0; i < s.length; i++) s[i] = (L[i] as number) - (R[i] as number);
      return db(rms(s)) - db(rms(mono(L, R)));
    };
    expect(side({ unison: 1, spread: 0 })).toBeLessThan(-100);
    expect(side({ unison: 7, spread: 1, detune: 30 })).toBeGreaterThan(-12);
  });

  it('the filter envelope sweeps from bright to dark on a stab', () => {
    const [L, R] = renderKeys(presetCfg('Techno Stab'), hit(48, 1, 0, 0.5), 0.6, SR);
    const m = mono(L, R);
    expect(centroid(spectrum(slice(m, SR, 0.005, 0.04), SR))).toBeGreaterThan(centroid(spectrum(slice(m, SR, 0.3, 0.45), SR)) * 1.5);
  });

  it('key tracking opens the filter for higher notes', () => {
    const bright = (note: number) => {
      const [L, R] = renderKeys(cfg('analog', { keyTrack: 1, envAmt: 0, unison: 1, sub: 0, noise: 0, ensemble: 0, attack: 0.001 }), hit(note, 0.8), 0.5, SR);
      const sp = spectrum(slice(mono(L, R), SR, 0.2, 0.5), SR);
      return centroid(sp) / (440 * Math.pow(2, (note - 69) / 12));
    };
    // relative to its pitch, the harmonic content stays similar instead of getting duller
    expect(bright(72)).toBeGreaterThan(bright(48) * 0.6);
  });

  it('the built-in delay echoes in time with the song tempo', () => {
    const echoAt = (bpm: number) => {
      const synth = new KeysSynth(SR, cfg('analog', { delayMix: 1, delayBeats: 0.5, space: 0, ensemble: 0, attack: 0.001, decay: 0.05, sustainLvl: 0, release: 0.02 }));
      synth.setTempo(bpm);
      const [L, R] = renderKeys(cfg('analog'), hit(60, 1, 0, 0.05), 1.2, SR, synth);
      const env = envelopeDb(mono(L, R), SR, 0.005);
      // strongest window after the dry note has died
      let best = 30;
      for (let i = 30; i < env.length; i++) if ((env[i] as number) > (env[best] as number)) best = i;
      return best * 0.005;
    };
    expect(echoAt(120)).toBeGreaterThan(0.23); // an 1/8 at 120 BPM = 0.25 s
    expect(echoAt(120)).toBeLessThan(0.28);
    expect(echoAt(60)).toBeGreaterThan(0.48);
    expect(echoAt(60)).toBeLessThan(0.54);
  });

  it('the motion LFO sweeps the filter over time', () => {
    const [L, R] = renderKeys(cfg('analog', { lfoDepth: 2.5, lfoRate: 1, envAmt: 0, cutoff: 800, ensemble: 0, space: 0, attack: 0.001 }), hit(48, 0.8), 2.2, SR);
    const m = mono(L, R);
    const cs = [0.2, 0.45, 0.7, 0.95, 1.2, 1.45, 1.7, 1.95].map((t) => centroid(spectrum(slice(m, SR, t, t + 0.05), SR)));
    expect(Math.max(...cs)).toBeGreaterThan(Math.min(...cs) * 2);
  });

  it('mono mode glides on legato notes and jumps on detached ones', () => {
    const acid = presetCfg('Acid Line', { glide: 0.1 });
    const pitchAt = (score: ScoreEvent[], t: number) => {
      const [L, R] = renderKeys(acid, score, t + 0.03, SR);
      const sp = spectrum(slice(mono(L, R), SR, t - 0.02, t + 0.02), SR, 1 << 16);
      return peakNear(sp, 90, 40).f;
    };
    // legato C2 → C3: 20 ms after the change the pitch is between the two
    const legato = [...hit(36, 1, 0, 0.6), ...hit(48, 1, 0.3, 0.6, 2)];
    const mid = pitchAt(legato, 0.34);
    expect(mid).toBeGreaterThan(70);
    expect(mid).toBeLessThan(125);
    // detached: the new pitch is there immediately
    const detached = [...hit(36, 1, 0, 0.2), ...hit(48, 1, 0.3, 0.6, 2)];
    expect(pitchAt(detached, 0.34)).toBeGreaterThan(125);
  });
});

describe('KeysCore', () => {
  it('starts notes on their exact sample frame', () => {
    const core = new KeysCore(SR, cfg('organ', { click: 0, rotorMix: 0, vibrato: 0, perc: 0 }));
    const startFrame = 1000;
    core.handleMessage({ type: 'noteOn', time: startFrame / SR, id: 1, note: 60, velocity: 1 });
    const L = new Float32Array(128);
    const R = new Float32Array(128);
    let first = -1;
    for (let b = 0; b < 16 && first < 0; b++) {
      core.process(b * 128, L, R);
      for (let i = 0; i < 128; i++) if (first < 0 && Math.abs(L[i] as number) > 1e-9) first = b * 128 + i;
    }
    // contacts may close up to a few ms late, never early
    expect(first).toBeGreaterThanOrEqual(startFrame);
    expect(first).toBeLessThan(startFrame + 0.004 * SR);
  });

  it('automation segments ramp engine parameters', () => {
    const core = new KeysCore(SR, cfg('analog', { cutoff: 200, envAmt: 0, ensemble: 0, attack: 0.001 }));
    core.handleMessage({ type: 'autoKeys', keys: ['cutoff'] });
    core.handleMessage({ type: 'noteOn', time: 0, id: 1, note: 48, velocity: 0.8 });
    core.handleMessage({ type: 'param', time: 0.25, key: 'cutoff', fromValue: 200, toTime: 0.5, toValue: 8000, exp: true });
    const total = Math.round(0.7 * SR / 128) * 128;
    const out = new Float32Array(total);
    const L = new Float32Array(128);
    const R = new Float32Array(128);
    for (let f = 0; f < total; f += 128) {
      core.process(f, L, R);
      out.set(L, f);
    }
    const early = centroid(spectrum(slice(out, SR, 0.1, 0.24), SR));
    const late = centroid(spectrum(slice(out, SR, 0.55, 0.69), SR));
    expect(late).toBeGreaterThan(early * 3);
    // a static config update must not override the automated value
    core.handleMessage({ type: 'config', config: cfg('analog', { cutoff: 100 }) });
    expect(core.synth.getParams().cutoff).toBeCloseTo(8000, 0);
  });

  it('switching engines fades the old engine out without a click', () => {
    const core = new KeysCore(SR, cfg('organ', { rotorMix: 0 }));
    core.handleMessage({ type: 'noteOn', time: -1, id: 1, note: 60, velocity: 1 });
    const L = new Float32Array(128);
    const R = new Float32Array(128);
    for (let f = 0; f < 20 * 128; f += 128) core.process(f, L, R);
    const prev = L[127] as number;
    core.handleMessage({ type: 'config', config: cfg('piano') });
    core.process(20 * 128, L, R);
    expect(Math.abs((L[0] as number) - prev)).toBeLessThan(0.05);
    expect(core.synth.engineName).toBe('piano');
  });
});

function midiHz(n: number): number {
  return 440 * Math.pow(2, (n - 69) / 12);
}
