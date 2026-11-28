/**
 * Measured quality of the built-in drum voices (src/drums/synth.ts): every
 * voice × style is checked with numbers, not by ear —
 *  - clean ends: exact silence at the end, no step there (the click metric), no DC;
 *  - transients: the hit starts on its first sample and rises within a millisecond;
 *  - kicks: no infrasonic mud, a low end that decays as set, a click that is there and then gone;
 *  - no aliasing: what a voice renders at 48 kHz matches its 192 kHz render band by band;
 *  - hats, snares, claps: energy where it belongs (bright, but no fizz at the top);
 *  - toms settle on a pitch; claps have distinct bursts;
 *  - the factory kits play at one loudness, with headroom.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { DRUM_STYLES, DRUM_VOICES, FACTORY_KITS } from '../src/drums/kit';
import { Partials } from '../src/drums/dsp';
import { DRUM_PEAK, renderDrumVoice } from '../src/drums/synth';
import type { DrumPadSource, DrumVoiceType } from '../src/project/types';
import { maxStep } from './clickMetric';
import { attackTimes, bandEnergy, bandEnvelope, centroid, db, firstMsDb, hitLoudness, integratedLoudness, peakOf, powerSpectrum, tailDb } from './helpers/drumMetrics';

const SR = 48000;
type Synth = Extract<DrumPadSource, { kind: 'synth' }>;
const src = (voice: DrumVoiceType, model: number, tone = 0.5, snap = 0.5, length = 0.4): Synth => ({ kind: 'synth', voice, tone, snap, length, model });
const STYLES = DRUM_STYLES.map((name, model) => ({ name, model }));
const label = (s: Synth) => `${s.voice}/${DRUM_STYLES[s.model ?? 0]} tone ${s.tone} snap ${s.snap} len ${s.length}`;

describe('every voice in every style ends clean', () => {
  // a grid over the macros: extremes of tone and snap, a very short and a long length
  const grid: Synth[] = [];
  for (const v of DRUM_VOICES) for (const { model } of STYLES) for (const [tone, snap, length] of [[0, 0, 0.05], [1, 1, 0.05], [0.5, 0.5, 0.4], [0, 1, 1.5], [1, 0, 1.5]] as const) grid.push(src(v.type, model, tone, snap, length));

  it('finite, peak at −1 dBFS, no DC; the last sample is exactly 0, the last 10 ms below −60 dB, a fade (not a cut) into it', () => {
    for (const s of grid) {
      const x = renderDrumVoice(s, SR);
      const l = label(s);
      expect(x.every(Number.isFinite), l).toBe(true);
      expect(peakOf(x), l).toBeCloseTo(DRUM_PEAK, 3);
      let sum = 0;
      for (const v of x) sum += v;
      expect(Math.abs(sum / x.length), `${l}: DC`).toBeLessThan(1e-3);
      expect(x[x.length - 1], l).toBe(0);
      expect(tailDb(x, SR, 10), `${l}: tail`).toBeLessThan(-60);
      // a cut-off tail steps to zero; a faded one moves no more than −46 dB per sample, and its last millisecond is below −80 dB
      expect(maxStep(x, x.length / SR - 0.012, x.length / SR + 1), `${l}: end step`).toBeLessThan(0.005);
      expect(20 * Math.log10(peakOf(x.subarray(x.length - SR / 1000)) / peakOf(x)), `${l}: last millisecond`).toBeLessThan(-80);
    }
  });

  it('length is the time to −60 dB: the buffer is the length plus a short fade (longer only for a clap’s bursts or a swell’s release)', () => {
    for (const s of grid) {
      const n = renderDrumVoice(s, SR).length / SR;
      expect(n, label(s)).toBeGreaterThanOrEqual(s.length);
      expect(n, label(s)).toBeLessThan(Math.max(s.length, 0.08) + 0.045);
    }
  });

  it('renders the same at 44.1 and 96 kHz: same length, normalized, clean end', () => {
    for (const sr of [44100, 96000]) {
      for (const v of DRUM_VOICES) {
        for (const { model } of STYLES) {
          const s = src(v.type, model);
          const x = renderDrumVoice(s, sr);
          expect(x.every(Number.isFinite), label(s)).toBe(true);
          expect(Math.abs(x.length / sr - renderDrumVoice(s, SR).length / SR), label(s)).toBeLessThan(2 / sr + 1e-9);
          expect(peakOf(x), label(s)).toBeCloseTo(DRUM_PEAK, 3);
          expect(x[x.length - 1], label(s)).toBe(0);
        }
      }
    }
  });

  it('is deterministic and uses no Math.random (the golden render stays reproducible)', () => {
    for (const v of DRUM_VOICES) expect(renderDrumVoice(src(v.type, 3), SR)).toEqual(renderDrumVoice(src(v.type, 3), SR));
    for (const f of readdirSync(new URL('../src/drums/', import.meta.url))) {
      expect(readFileSync(new URL(`../src/drums/${f}`, import.meta.url), 'utf8'), f).not.toMatch(/Math\.random/);
    }
  });
});

describe('transients', () => {
  // the voices that are hits (a shaker swells on purpose, a reverse crash and the FX sweep)
  const HITS: DrumVoiceType[] = ['kick', 'snare', 'clap', 'rim', 'tom', 'hatClosed', 'hatOpen', 'cowbell', 'perc'];
  it('every hit starts on its first sample (10 % within 0.3 ms) and at full strength (its first millisecond within 3.5 dB of its loudest)', () => {
    // (a 1 ms fade-in alone costs 4.8 dB; Lo-Fi's sampler filters, like a real sampler's, delay it a little)
    for (const v of HITS) {
      for (const { model } of STYLES) {
        for (const snap of [0, 1]) {
          const s = src(v, model, 0.5, snap);
          const x = renderDrumVoice(s, SR);
          expect(attackTimes(x, SR).onsetMs, `${label(s)}: onset`).toBeLessThanOrEqual(model === 5 ? 0.35 : 0.3);
          expect(firstMsDb(x, SR), `${label(s)}: first millisecond`).toBeGreaterThan(model === 5 ? -5 : -3.5);
        }
      }
    }
  });

  it('a cowbell is loudest on the hit: its two squares start together on their crest (started anyhow, they line up a beat — 3.85 ms — later)', () => {
    for (const { model } of STYLES) for (const snap of [0, 1]) {
      const s = src('cowbell', model, 0.5, snap);
      expect(firstMsDb(renderDrumVoice(s, SR), SR), label(s)).toBeGreaterThan(-1);
    }
  });

  it('a crash blooms in 2.5 ms; a shaker swells (its attack set by snap)', () => {
    for (const model of [0, 1, 3, 4, 5]) expect(attackTimes(renderDrumVoice(src('crash', model), SR), SR).riseMs, DRUM_STYLES[model]).toBeLessThan(2.5);
    const soft = attackTimes(renderDrumVoice(src('shaker', 0, 0.5, 0), SR), SR, 2, 60);
    const hard = attackTimes(renderDrumVoice(src('shaker', 0, 0.5, 1), SR), SR, 2, 60);
    expect(soft.riseMs).toBeGreaterThan(hard.riseMs * 2);
  });
});

describe('kicks: defined low end, controlled sub, a clear click', () => {
  const kicks: Synth[] = [];
  for (const { model } of STYLES) for (const [tone, snap, length] of [[0, 0, 0.3], [0.5, 0.5, 0.5], [1, 1, 0.8], [0.4, 0.5, 1.6]] as const) kicks.push(src('kick', model, tone, snap, length));

  it('no infrasonic mud: below 30 Hz at least 20 dB under the 40–150 Hz body', () => {
    for (const s of kicks) {
      const p = powerSpectrum(renderDrumVoice(s, SR), SR);
      expect(db(bandEnergy(p, 0, 30) / bandEnergy(p, 40, 150)), label(s)).toBeLessThan(-20);
    }
  });

  it('the low end decays as set: 20 dB down by 60 % of the length, 50 dB down at the length', () => {
    for (const s of kicks) {
      const x = renderDrumVoice(s, SR);
      const env = bandEnvelope(x, SR, 20, 150, 10);
      const top = Math.max(...env);
      const at = (t: number) => env[Math.floor((t * 1000) / 10)] as number;
      expect(at(0.6 * s.length) - top, `${label(s)} at 60 %`).toBeLessThan(-20);
      expect(at(s.length - 0.01) - top, `${label(s)} at the end`).toBeLessThan(-50);
    }
  });

  it('a click: 1.5–8 kHz is there in the first 8 ms (within 30 dB of the hit), and above 3 kHz it is 40 dB down after 40 ms', () => {
    for (const s of kicks) {
      const x = renderDrumVoice(s, SR);
      const early = powerSpectrum(x, SR, 0, 0.008);
      expect(db(bandEnergy(early, 1500, 8000) / bandEnergy(early, 0, 24000)), `${label(s)}: click`).toBeGreaterThan(-30);
      // (above 3 kHz: below it a driven body has overtones of its own; those are the body, not a lingering click)
      const env = bandEnvelope(x, SR, 3000, 10000, 4);
      // (Lo-Fi keeps its 12-bit dust there on purpose)
      expect((env[10] as number) - Math.max(env[0] as number, env[1] as number), `${label(s)}: click gone`).toBeLessThan(s.model === 5 ? -25 : -40);
    }
  });
});

/** third-octave band energies, 100 Hz – 16 kHz, at 48 kHz density, as fractions of the whole spectrum's energy */
function thirdOctaves(x: Float32Array, sr: number, from: number, to: number): number[] {
  const p = powerSpectrum(x, sr, from, to, 'bh4');
  const total = bandEnergy(p, 0, sr / 2);
  const out: number[] = [];
  for (let f = 100; f < 16000; f *= Math.cbrt(2)) out.push(bandEnergy(p, f, f * Math.cbrt(2)) / total);
  return out;
}

/**
 * Aliasing: a voice rendered at 48 kHz against the same voice at 192 kHz (where
 * nothing it makes can fold back below 20 kHz), band by band from 100 Hz to `top`
 * Hz, each as a share of its own render's energy (each render is peak-normalized on
 * its own). Folded energy shows up as bands the 48 kHz render has and the 192 kHz
 * one doesn't. Returns the worst band difference (dB) over the bands that hold at
 * least −60 dB of the voice's energy (below that: window leakage and rounding).
 */
function aliasDb(s: Synth, from: number, to: number, top = 16000): number {
  const keep = (_: number, i: number) => 100 * Math.pow(2, i / 3) < top;
  const a = thirdOctaves(renderDrumVoice(s, SR), SR, from, to).filter(keep);
  const b = thirdOctaves(renderDrumVoice(s, 192000), 192000, from, to).filter(keep);
  let worst = 0;
  a.forEach((e, i) => {
    if (Math.max(e, b[i] as number) > 1e-6) worst = Math.max(worst, Math.abs(db(e) - db(b[i] as number)));
  });
  return worst;
}

describe('no aliasing (48 kHz vs 192 kHz renders, band by band)', () => {
  it('kick sweeps, toms, zaps and FM / partial percussion (the deterministic parts, after any noise has died)', () => {
    const cases: Synth[] = [];
    // (Lo-Fi is a 26 kHz sampler on purpose: its own test below)
    for (const model of [0, 1, 2, 3, 4]) for (const [tone, snap] of [[0, 0], [1, 1]] as const) cases.push(src('kick', model, tone, snap, 0.5));
    for (const model of [0, 4]) cases.push(src('tom', model, 1, 1, 0.5));
    for (const model of [0, 1]) cases.push(src('zap', model, 1, 1, 0.4));
    for (const model of [0, 2, 4]) cases.push(src('perc', model, 1, 1, 0.4));
    for (const s of cases) expect(aliasDb(s, 0.04, s.length), label(s)).toBeLessThan(0.5);
  });

  it('cowbells: band-limited squares (a naive square folds its harmonics back all over the band)', () => {
    // up to 6 kHz: above it the 48 kHz filters' own response near Nyquist (bilinear cramping) differs from 192 kHz
    for (const { model } of STYLES) for (const tone of [0, 1]) {
      const s = src('cowbell', model, tone, 0, 0.4);
      if (model !== 5) expect(aliasDb(s, 0.03, 0.35, 6000), label(s)).toBeLessThan(1);
    }
  });

  it('Lo-Fi is a deliberate 12-bit / 26 kHz sampler: band-limited to its 13 kHz Nyquist, so its grit is the bits and the dark top, not folded images', () => {
    for (const v of DRUM_VOICES) {
      const p = powerSpectrum(renderDrumVoice(src(v.type, 5, 1, 1, 0.4), SR), SR);
      expect(db(bandEnergy(p, 13500, 24000) / bandEnergy(p, 0, 24000)), v.type).toBeLessThan(-45);
    }
  });

  it('the band-limited square itself: nothing between its harmonics, up to Nyquist', () => {
    for (const f of [523.25, 1975.5, 4186]) {
      const p = new Partials(SR);
      p.addSquare(f, 1);
      const x = new Float32Array(SR / 2);
      for (let i = 0; i < x.length; i++) x[i] = p.next();
      const s = powerSpectrum(x, SR, 0, x.length / SR, 'bh4');
      let on = 0;
      let off = 0;
      for (let k = 0; k < s.p.length; k++) {
        const fk = k * s.binHz;
        const h = fk / f;
        // within 2 % of an odd harmonic counts as the harmonic (window leakage)
        if (Math.abs(h - Math.round(h)) * f < Math.max(0.02 * f, 6 * s.binHz) && Math.round(h) % 2 === 1) on += s.p[k] as number;
        else off += s.p[k] as number;
      }
      expect(db(off / on), `square at ${f} Hz`).toBeLessThan(-60);
    }
  });

  it('hats and cymbals: nothing folds down below 4 kHz (octave bands of the 48 kHz render no louder than at 192 kHz)', () => {
    // (not Lo-Fi: a 26 kHz sampler emulated at 48 vs 192 kHz is not the same machine; see its own test)
    for (const v of ['hatClosed', 'hatOpen', 'crash'] as const) for (const model of [0, 1, 2, 3, 4]) {
      const s = src(v, model, 0.5, 0.5, v === 'hatClosed' ? 0.1 : 0.8);
      const pa = powerSpectrum(renderDrumVoice(s, SR), SR);
      const pb = powerSpectrum(renderDrumVoice(s, 192000), 192000);
      const ta = bandEnergy(pa, 0, 16000);
      const tb = bandEnergy(pb, 0, 16000);
      for (let f = 125; f < 4000; f *= 2) {
        const a = bandEnergy(pa, f, 2 * f) / ta;
        const b = bandEnergy(pb, f, 2 * f) / tb;
        // (bands 80 dB under the hat are rounding noise, whatever their ratio)
        if (a > 1e-8) expect(db(a) - db(b), `${label(s)}: ${f}–${2 * f} Hz at ${db(a).toFixed(0)} dB`).toBeLessThan(2);
      }
    }
  });
});

describe('where the energy is', () => {
  it('hats: bright (centroid 6–13 kHz), clean below 2 kHz, and no fizz piled up above 16 kHz', () => {
    for (const v of ['hatClosed', 'hatOpen'] as const) for (const { model } of STYLES) for (const tone of [0, 1]) {
      const s = src(v, model, tone, 0.5, v === 'hatOpen' ? 0.5 : 0.08);
      const p = powerSpectrum(renderDrumVoice(s, SR), SR);
      const all = bandEnergy(p, 0, 24000);
      const c = centroid(p);
      expect(c, `${label(s)}: centroid`).toBeGreaterThan(model === 3 || model === 5 ? 4500 : 6000);
      expect(c, `${label(s)}: centroid`).toBeLessThan(13000);
      // (Lo-Fi's saturated 12-bit dust reaches lower: deliberately, but still 20 dB down)
      expect(db(bandEnergy(p, 0, 2000) / all), `${label(s)}: lows`).toBeLessThan(model === 5 ? -20 : -30);
      expect(db(bandEnergy(p, 16000, 24000) / bandEnergy(p, 5000, 16000)), `${label(s)}: fizz`).toBeLessThan(-8);
    }
  });

  it('snares: a body (120–700 Hz: its two modes) in the first 50 ms and bright noise (2–12 kHz), no fizz above 16 kHz', () => {
    for (const { model } of STYLES) for (const [tone, snap] of [[0, 0], [0.5, 0.5], [1, 1]] as const) {
      const s = src('snare', model, tone, snap, 0.3);
      const x = renderDrumVoice(s, SR);
      const early = powerSpectrum(x, SR, 0, 0.05);
      const all = bandEnergy(early, 0, 24000);
      expect(db(bandEnergy(early, 120, 700) / all), `${label(s)}: body`).toBeGreaterThan(-15);
      const p = powerSpectrum(x, SR);
      const tot = bandEnergy(p, 0, 24000);
      expect(db(bandEnergy(p, 2000, 12000) / tot), `${label(s)}: wires`).toBeGreaterThan(model === 3 || model === 5 ? -9 : -6);
      expect(db(bandEnergy(p, 16000, 24000) / tot), `${label(s)}: fizz`).toBeLessThan(-12);
    }
  });

  it('claps: distinct bursts 5–15 ms apart (at least three; two for the tight Techno clap), bright (centroid 2–6 kHz)', () => {
    for (const { model, name } of STYLES) for (const snap of [0, 1]) {
      const s = src('clap', model, 0.5, snap, 0.35);
      const x = renderDrumVoice(s, SR);
      // 1 ms RMS envelope over the first 45 ms (a clap's bursts; after them its tail, a noise whose
      // own ripple is no burst); a burst is a peak within 9 dB of the loudest, with a 6 dB dip from the one before
      const env = bandEnvelope(x, SR, 300, 20000, 1).slice(0, 45);
      const top = Math.max(...env);
      const peaks: number[] = [];
      let lastPeak = -1;
      let minSince = Infinity;
      for (let i = 0; i < env.length - 1; i++) {
        const e = env[i] as number;
        minSince = Math.min(minSince, e);
        const isPeak = e >= (env[i - 1] ?? -Infinity) && e >= (env[i + 1] as number) && e > top - 9;
        if (isPeak && (lastPeak < 0 || ((env[lastPeak] as number) - minSince > 6 && e - minSince > 6))) {
          peaks.push(i);
          lastPeak = i;
          minSince = Infinity;
        }
      }
      expect(peaks.length, `${name} clap bursts at ${peaks.join(', ')} ms`).toBeGreaterThanOrEqual(model === 2 ? 2 : 3);
      for (let k = 1; k < peaks.length; k++) {
        expect((peaks[k] as number) - (peaks[k - 1] as number), `${name} clap spacing`).toBeGreaterThanOrEqual(5);
        expect((peaks[k] as number) - (peaks[k - 1] as number), `${name} clap spacing`).toBeLessThanOrEqual(15);
      }
      const c = centroid(powerSpectrum(x, SR));
      expect(c, `${name} clap centroid`).toBeGreaterThan(model === 3 || model === 5 ? 1500 : 2000);
      expect(c, `${name} clap centroid`).toBeLessThan(6000);
    }
  });

  it('toms are tuned: after the drop they hold one pitch, which Tone raises', () => {
    const pitch = (x: Float32Array, from: number) => {
      const p = powerSpectrum(x, SR, from, from + 0.12);
      let k = 1;
      for (let i = 1; i < p.p.length; i++) if ((p.p[i] as number) > (p.p[k] as number)) k = i;
      // parabolic interpolation of the peak bin
      const a = Math.log((p.p[k - 1] as number) + 1e-30), b = Math.log(p.p[k] as number), c = Math.log((p.p[k + 1] as number) + 1e-30);
      return (k + (0.5 * (a - c)) / (a - 2 * b + c)) * p.binHz;
    };
    for (const { model, name } of STYLES) {
      let prev = 0;
      for (const tone of [0, 0.5, 1]) {
        const x = renderDrumVoice(src('tom', model, tone, 0.5, 1.2), SR);
        const f1 = pitch(x, 0.45);
        const f2 = pitch(x, 0.6);
        expect(Math.abs(f2 / f1 - 1), `${name} tom tone ${tone}: ${f1.toFixed(1)} → ${f2.toFixed(1)} Hz`).toBeLessThan(0.01);
        expect(f1, `${name} tom: tone raises the pitch`).toBeGreaterThan(prev * 1.15);
        prev = f1;
      }
    }
  });
});

describe('the factory kits play at one loudness, with headroom', () => {
  /** a pad's hit as the rack plays it: tuned by playback rate, pad gain, full velocity */
  function hit(kit: (typeof FACTORY_KITS)[number]['kit'], i: number): Float32Array {
    const p = kit.pads[i]!;
    const x = renderDrumVoice(p.source as Synth, SR);
    const rate = Math.pow(2, p.tune / 12);
    const g = Math.pow(10, p.gain / 20);
    const y = new Float32Array(Math.floor(x.length / rate));
    for (let k = 0; k < y.length; k++) {
      const q = k * rate;
      const j = Math.floor(q);
      y[k] = ((x[j] as number) * (1 - (q - j)) + (x[j + 1] ?? 0) * (q - j)) * g;
    }
    return y;
  }
  const kits = FACTORY_KITS.map(({ name, kit }) => {
    const hits = kit.pads.map((_, i) => hit(kit, i));
    const first = (v: DrumVoiceType) => kit.pads.findIndex((p) => p.source.kind === 'synth' && p.source.voice === v);
    return { name, kit, hits, first };
  });

  it('the main pads of every kit (kick, snare, clap, closed and open hat) are within ±1.5 dB of that role in the other kits', () => {
    for (const role of ['kick', 'snare', 'clap', 'hatClosed', 'hatOpen'] as const) {
      const levels = kits.map((k) => ({ name: k.name, l: hitLoudness(k.hits[k.first(role)]!) }));
      const mean = levels.reduce((a, b) => a + b.l, 0) / levels.length;
      for (const { name, l } of levels) expect(Math.abs(l - mean), `${name} ${role}: ${l.toFixed(1)} LUFS vs ${mean.toFixed(1)}`).toBeLessThan(1.5);
    }
  });

  it('every kit plays the same beat within ±1 dB, peaking at −1 dBFS or lower', () => {
    const step = SR / 8;
    const results = kits.map(({ name, hits, first }) => {
      const mix = new Float64Array(step * 64 + SR * 2);
      // the rack's pan law: a centred mono hit is −3 dB in each channel
      const add = (i: number, s: number, vel: number) => {
        const h = hits[i]!;
        const g = (0.15 + 0.85 * vel ** 1.3) * Math.SQRT1_2;
        for (let k = 0; k < h.length && s * step + k < mix.length; k++) mix[s * step + k]! += (h[k] as number) * g;
      };
      for (let bar = 0; bar < 4; bar++) {
        const o = bar * 16;
        add(first('kick'), o, 1);
        add(first('kick'), o + 8, 1);
        add(first('snare'), o + 4, 1);
        add(first('snare'), o + 12, 1);
        add(first('clap'), o + 12, 0.7);
        for (let s = 0; s < 14; s += 2) add(first('hatClosed'), o + s, s % 4 ? 0.6 : 0.8);
        add(first('hatOpen'), o + 14, 0.7);
      }
      const f = Float32Array.from(mix);
      return { name, lufs: integratedLoudness([f, f]), peakDb: 20 * Math.log10(peakOf(f)) };
    });
    const mean = results.reduce((a, b) => a + b.lufs, 0) / results.length;
    for (const r of results) {
      expect(Math.abs(r.lufs - mean), `${r.name}: ${r.lufs.toFixed(1)} LUFS vs ${mean.toFixed(1)}`).toBeLessThan(1);
      expect(r.peakDb, `${r.name} peak`).toBeLessThan(-1);
    }
  });

  it('no single pad of any kit peaks above −1 dBFS at full velocity', () => {
    for (const { name, kit, hits } of kits) hits.forEach((h, i) => expect(20 * Math.log10(peakOf(h) * Math.SQRT1_2), `${name} / ${kit.pads[i]!.name}`).toBeLessThan(-1));
  });
});
