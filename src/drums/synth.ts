/**
 * Procedural drum synthesis for the built-in Drum Rack sounds (pure, no Web
 * Audio). Every voice is rendered once into a mono buffer from three macro
 * controls — tone (pitch / brightness), snap (transient / noise amount) and
 * length (time to −60 dB) — and a style (model, see DRUM_MODELS in kit.ts):
 * Classic, House, Techno, Hip-Hop, Trap or Lo-Fi.
 *
 * Built for clean, crisp hits (building blocks in dsp.ts; measured in tests/drumQuality.test.ts):
 *  - the onset is the first sample: low tones start on a crest with a 0.1 ms
 *    ramp, noise with 0.1–0.2 ms — no fade-in smearing the transient — and
 *    only causal filters (nothing rings ahead of the hit);
 *  - tones are sine partials and band-limited squares, so sweeps, bells and
 *    metal never alias; noise is shaped by proper 2nd/4th-order filters;
 *  - kicks: a swept sine with its overtones added (cosines, cresting together)
 *    and a tanh drive on the low body only (alias-free there), a click, and a
 *    fundamental no lower than 38 Hz (no infrasonic mud);
 *  - every voice reaches −60 dB at its length, then a 12 ms raised-cosine fade
 *    takes it to exact silence; no DC (a 20 Hz high-pass, or for kicks their
 *    exact mean taken off — see finish());
 *  - peak-normalized to −1 dBFS; the factory kits balance loudness with pad gain;
 *  - deterministic: a seeded noise generator, so a kit always renders the same
 *    (realtime, export and tests).
 */
import type { DrumPadSource, DrumVoiceType } from '../project/types';
import { BW4, BW8, Biquad, Chain, Partials, Svf, Sweep, TWO_PI, attack, bandTop, decay, harmonicSum, noiseGen } from './dsp';

type SynthSource = Extract<DrumPadSource, { kind: 'synth' }>;

const CLASSIC = 0;
const HOUSE = 1;
const TECHNO = 2;
const HIPHOP = 3;
const TRAP = 4;
const LOFI = 5;

/** attack of the low tones (kick and tom bodies): they start on a crest, so this is all the ramp they need */
const ATTACK_LOW = 0.0001;
/** the end fade after a voice has reached −60 dB */
const END_FADE = 0.012;
/** release of the voices that swell up to their length (reverse crash, swoosh) */
const REVERSE_RELEASE = 0.03;
/** peak level of every rendered voice (−1 dBFS) */
export const DRUM_PEAK = 0.89;

interface Voice {
  sr: number;
  out: Float64Array;
  /** white noise with the same density per Hz at every sample rate */
  noise: () => number;
  tone: number;
  snap: number;
  /** seconds to −60 dB */
  len: number;
}

const lerp = (r: readonly [number, number], x: number) => r[0] + (r[1] - r[0]) * x;

// ---------------------------------------------------------------- kick

interface KickStyle {
  f0: number;
  fRange: number;
  /** start / end frequency of the pitch drop, by snap */
  ratio: [number, number];
  /** time constant of the pitch drop, by snap */
  tau: [number, number];
  curve: number;
  /** overtones of the body: [unused, 2nd, 3rd, …] */
  h: number[];
  /** overtones fade with this fraction of the length */
  hDecay: number;
  click: { fc: number; q: number; amt: [number, number]; dec: number };
  knock?: { f: number; amt: [number, number]; dec: number };
  /**
   * tanh drive of the body: density without aliasing — the body is a low sine
   * (≤ ~600 Hz even at the top of the sweep), and tanh's harmonics of it fall
   * off exponentially (the 40th, at 24 kHz, is > 200 dB down)
   */
  drive: number;
}

const KICKS: Record<number, KickStyle> = {
  [CLASSIC]: { f0: 44, fRange: 30, ratio: [3.5, 8], tau: [0.022, 0.012], curve: 1.5, h: [0, 0.1, 0.14, 0.04], hDecay: 0.25, click: { fc: 3800, q: 0.8, amt: [0.6, 1.3], dec: 0.0025 }, drive: 1.6 },
  [HOUSE]: { f0: 48, fRange: 28, ratio: [5, 9], tau: [0.011, 0.007], curve: 1.3, h: [0, 0.06, 0.16, 0, 0.05], hDecay: 0.15, click: { fc: 2200, q: 0.6, amt: [0.6, 1.3], dec: 0.005 }, drive: 1.9 },
  [TECHNO]: { f0: 42, fRange: 24, ratio: [4, 7.5], tau: [0.025, 0.014], curve: 1.25, h: [0, 0.22, 0.3, 0.12, 0.1, 0.05], hDecay: 0.3, click: { fc: 4500, q: 1, amt: [0.5, 1.3], dec: 0.003 }, drive: 2.6 },
  [HIPHOP]: { f0: 50, fRange: 24, ratio: [2.2, 3.6], tau: [0.034, 0.024], curve: 1.4, h: [0, 0.16, 0.05], hDecay: 0.5, click: { fc: 1800, q: 0.7, amt: [0.45, 0.9], dec: 0.004 }, knock: { f: 185, amt: [0.25, 0.55], dec: 0.014 }, drive: 1.8 },
  [TRAP]: { f0: 38, fRange: 22, ratio: [1.6, 2.8], tau: [0.035, 0.025], curve: 1.8, h: [0, 0.2, 0.09], hDecay: 1, click: { fc: 3000, q: 0.9, amt: [0.8, 1.6], dec: 0.0015 }, drive: 1.5 },
};

function kick(v: Voice, s: KickStyle): void {
  const { sr, out, tone, snap, len } = v;
  const fEnd = s.f0 + tone * s.fRange;
  const fStart = fEnd * lerp(s.ratio, snap);
  const norm = 1 / Math.tanh(s.drive);
  // the drive lifts quiet parts by drive / tanh(drive): decay that much further so the tail still reaches −60 dB at the length
  const depth = 6.9 + Math.log(s.drive * norm);
  // the body crests 0.05 ms in, as its 0.1 ms attack completes
  const sweep = new Sweep(fEnd, fStart, lerp(s.tau, snap), sr, -Math.PI * fStart * ATTACK_LOW);
  const clickBp = Biquad.bandpass(s.click.fc, s.click.q, sr);
  const clickAmt = lerp(s.click.amt, snap);
  const knockAmt = s.knock ? lerp(s.knock.amt, snap) : 0;
  const odd = s.h.map((w, k) => (k % 2 === 0 ? w : 0));
  const even = s.h.map((w, k) => (k % 2 === 1 ? w : 0));
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const ph = sweep.next();
    const env = attack(t, ATTACK_LOW) * decay(t, len, s.curve, depth);
    const hEnv = Math.exp(-t / (s.hDecay * len));
    // Cosines, so the hit starts on the body's crest with every overtone. The drive sees the
    // odd overtones only: a half-wave symmetric wave stays symmetric through tanh, so it makes
    // no DC and needs no high-pass (whose recovery would lift later crests over the first);
    // the even overtones (warmth) are added after it.
    let x = Math.tanh(s.drive * (Math.cos(ph) + hEnv * harmonicSum(ph, sweep.freq, odd, sr)) * env) * norm;
    x += hEnv * harmonicSum(ph, sweep.freq, even, sr) * env;
    if (s.knock) x += Math.cos(TWO_PI * s.knock.f * t) * knockAmt * attack(t, ATTACK_LOW) * Math.exp(-t / s.knock.dec) * decay(t, len, 1, depth);
    out[i] = x + clickBp.process(v.noise()) * clickAmt * attack(t, 0.0001) * Math.exp(-t / s.click.dec);
  }
}

// ---------------------------------------------------------------- tom

interface TomStyle {
  f0: number;
  range: number;
  drop: [number, number];
  tau: number;
  /** second membrane mode (×1.59), relative level */
  mode2: number;
  h2: number;
  skin: { fc: number; q: number; amt: [number, number]; dec: number };
  curve: number;
}

const TOMS: Record<number, TomStyle> = {
  [CLASSIC]: { f0: 72, range: 190, drop: [0.35, 0.9], tau: 0.035, mode2: 0.18, h2: 0.05, skin: { fc: 2400, q: 0.8, amt: [0.08, 0.3], dec: 0.012 }, curve: 1.15 },
  [HOUSE]: { f0: 90, range: 170, drop: [0.2, 0.45], tau: 0.03, mode2: 0.12, h2: 0.04, skin: { fc: 1800, q: 0.6, amt: [0.15, 0.45], dec: 0.02 }, curve: 1.1 },
  [TECHNO]: { f0: 80, range: 200, drop: [1, 1.8], tau: 0.08, mode2: 0, h2: 0.08, skin: { fc: 3000, q: 0.5, amt: [0.05, 0.3], dec: 0.05 }, curve: 1 },
  [HIPHOP]: { f0: 52, range: 95, drop: [0.35, 0.6], tau: 0.06, mode2: 0.15, h2: 0.12, skin: { fc: 900, q: 0.7, amt: [0.2, 0.5], dec: 0.03 }, curve: 1.2 },
  [TRAP]: { f0: 100, range: 200, drop: [0.2, 0.5], tau: 0.08, mode2: 0, h2: 0.03, skin: { fc: 2500, q: 0.8, amt: [0, 0.06], dec: 0.005 }, curve: 1.3 },
};

function tom(v: Voice, s: TomStyle): void {
  const { sr, out, tone, snap, len } = v;
  const f = s.f0 + tone * s.range;
  const drop = lerp(s.drop, snap);
  const body = new Sweep(f, f * (1 + drop), s.tau, sr, -Math.PI * f * (1 + drop) * ATTACK_LOW);
  const m2 = new Sweep(f * 1.59, f * 1.59 * (1 + drop), s.tau, sr);
  const skin = Biquad.bandpass(s.skin.fc, s.skin.q, sr);
  const skinAmt = lerp(s.skin.amt, snap);
  const h = [0, s.h2];
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const ph = body.next();
    const p2 = m2.next();
    const env = attack(t, ATTACK_LOW) * decay(t, len, s.curve);
    const tonal = Math.cos(ph) + harmonicSum(ph, body.freq, h, sr) + s.mode2 * Math.sin(p2) * decay(t, len * 0.4);
    out[i] = tonal * env + skin.process(v.noise()) * skinAmt * attack(t, 0.0002) * Math.exp(-t / s.skin.dec) * decay(t, len);
  }
}

// ---------------------------------------------------------------- snare

interface SnareStyle {
  f0: number;
  range: number;
  /** second body mode */
  ratio: number;
  drop: number;
  dropTau: number;
  bodyLen: number;
  body: number;
  noise: number;
  hp: number;
  pk: [number, number, number];
  lp: number;
  curve: number;
  /** extra noise right at the hit, by snap */
  burst: [number, number];
  crack: { fc: number; amt: number };
  /** Techno: noise held for this fraction of the length, then gated off */
  gate?: number;
  /** Techno: a metallic ring */
  ring?: number;
  /** Trap: clap bursts layered in */
  clap?: number[];
}

const SNARES: Record<number, SnareStyle> = {
  [CLASSIC]: { f0: 180, range: 90, ratio: 1.7, drop: 0.35, dropTau: 0.01, bodyLen: 0.1, body: 1.1, noise: 0.9, hp: 1500, pk: [6000, 0.8, 4], lp: 15000, curve: 1.35, burst: [0.1, 0.5], crack: { fc: 3500, amt: 0.6 } },
  [HOUSE]: { f0: 185, range: 75, ratio: 1.85, drop: 0.15, dropTau: 0.008, bodyLen: 0.08, body: 0.9, noise: 1, hp: 2200, pk: [8000, 0.7, 3], lp: 16500, curve: 1.2, burst: [0.1, 0.45], crack: { fc: 4500, amt: 0.4 } },
  [TECHNO]: { f0: 215, range: 100, ratio: 1.6, drop: 0.3, dropTau: 0.006, bodyLen: 0.05, body: 1.2, noise: 1, hp: 1800, pk: [5000, 1, 5], lp: 13000, curve: 1, burst: [0.15, 0.5], crack: { fc: 3500, amt: 0.8 }, gate: 0.6, ring: 0.25 },
  [HIPHOP]: { f0: 175, range: 60, ratio: 1.6, drop: 0.4, dropTau: 0.014, bodyLen: 0.14, body: 1.1, noise: 0.85, hp: 700, pk: [2800, 0.7, 3], lp: 10500, curve: 1.4, burst: [0.1, 0.35], crack: { fc: 2500, amt: 0.3 } },
  [TRAP]: { f0: 300, range: 150, ratio: 1.5, drop: 0.2, dropTau: 0.005, bodyLen: 0.05, body: 1.4, noise: 0.8, hp: 2000, pk: [7000, 0.8, 3], lp: 16000, curve: 1.2, burst: [0.05, 0.25], crack: { fc: 4000, amt: 0.5 }, clap: [0, 0.008, 0.016] },
};

function snare(v: Voice, s: SnareStyle): void {
  const { sr, out, tone, snap, len } = v;
  const f1 = s.f0 + tone * s.range;
  // both modes start on a crest, 0.1 ms in (with the attack): the sharpest onset, next to no DC
  const m1 = new Sweep(f1, f1 * (1 + s.drop), s.dropTau, sr, Math.PI / 2 - Math.PI * f1 * (1 + s.drop) * ATTACK_LOW);
  const m2 = new Sweep(f1 * s.ratio, f1 * s.ratio * (1 + s.drop), s.dropTau, sr, Math.PI / 2 - Math.PI * f1 * s.ratio * (1 + s.drop) * ATTACK_LOW);
  const bodyLen = Math.min(len, s.bodyLen);
  const bodyAmt = s.body * (1 - snap * 0.35);
  const wires = new Chain([Biquad.highpass(s.hp, 0.7, sr), Biquad.peak(s.pk[0], s.pk[1], s.pk[2], sr), Biquad.lowpass(s.lp, 0.7, sr)]);
  const crack = Biquad.bandpass(s.crack.fc, 1.1, sr);
  const burst = lerp(s.burst, snap);
  const gate = s.gate ? Math.max(0.02, len * s.gate) : 0;
  const ring = new Partials(sr);
  if (s.ring) for (const r of [2.3, 3.7, 5.1]) ring.add((380 + tone * 200) * r, s.ring / 3, 0.1);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const a = attack(t, ATTACK_LOW);
    // the body is low sines, so tanh drives it without aliasing (the wires stay linear)
    const body = Math.tanh(1.5 * (Math.sin(m1.next()) + 0.55 * Math.sin(m2.next())) * decay(t, bodyLen)) * bodyAmt;
    let nEnv = gate ? (t < gate ? 1 : decay(t - gate, 0.04)) * decay(t, len * 1.6) : decay(t, len, s.curve);
    nEnv *= 1 + burst * Math.exp(-t / 0.005);
    if (s.clap) {
      let c = 0;
      for (const b of s.clap) if (t >= b) c = Math.max(c, attack(t - b, 0.00015) * Math.exp(-(t - b) / 0.004));
      nEnv += c * 0.9;
    }
    const n = v.noise();
    // the crack: a 1.5 ms band of noise right at the hit (its strength by snap, never none: the attack is sharp at any snap)
    let x = body + wires.process(n) * nEnv * s.noise + crack.process(n) * s.crack.amt * (0.4 + 0.6 * snap) * Math.exp(-t / 0.0015);
    if (s.ring) x += ring.next() * (gate && t > gate ? decay(t - gate, 0.04) : 1) * decay(t, len);
    out[i] = x * a;
  }
}

// ---------------------------------------------------------------- clap

interface ClapStyle {
  bursts: number[];
  amps: number[];
  /** the hand-clap resonance: centre (by tone), Q, boost (dB) over a broadband 500 Hz – lp noise */
  fc: [number, number];
  q: number;
  boost: number;
  lp: number;
  tail: number;
  tailCurve: number;
}

const CLAPS: Record<number, ClapStyle> = {
  [CLASSIC]: { bursts: [0, 0.0095, 0.0205, 0.031], amps: [1, 0.85, 0.9, 0.95], fc: [1100, 1900], q: 1.2, boost: 9, lp: 12000, tail: 0.5, tailCurve: 1 },
  [HOUSE]: { bursts: [0, 0.0085, 0.0175, 0.0265, 0.036], amps: [1, 0.8, 0.9, 0.85, 0.95], fc: [1000, 1700], q: 1, boost: 9, lp: 10500, tail: 0.65, tailCurve: 0.85 },
  [TECHNO]: { bursts: [0, 0.0065], amps: [1, 0.95], fc: [1500, 2800], q: 1.4, boost: 8, lp: 11000, tail: 0.22, tailCurve: 1.2 },
  [HIPHOP]: { bursts: [0, 0.011, 0.0215, 0.0295, 0.0405], amps: [1, 0.9, 0.8, 0.9, 0.95], fc: [900, 1500], q: 0.8, boost: 10, lp: 9500, tail: 0.55, tailCurve: 1 },
  [TRAP]: { bursts: [0, 0.0055, 0.011], amps: [1, 0.9, 0.95], fc: [1400, 2600], q: 1.1, boost: 7, lp: 12500, tail: 0.35, tailCurve: 1.1 },
};

/** the clap's last burst: the tail (and the voice's shortest length) starts there */
const clapLast = (s: ClapStyle) => s.bursts[s.bursts.length - 1] as number;

function clap(v: Voice, s: ClapStyle): void {
  const { sr, out, tone, snap, len } = v;
  const band = new Chain([Biquad.highpass(500, 0.7, sr), Biquad.peak(lerp(s.fc, tone), s.q, s.boost, sr), Biquad.lowpass(s.lp, 0.7, sr)]);
  // each burst dies well before the next (distinct claps, not a smear): a fraction of the tightest spacing
  let spacing = Infinity;
  for (let k = 1; k < s.bursts.length; k++) spacing = Math.min(spacing, (s.bursts[k] as number) - (s.bursts[k - 1] as number));
  const tau = Math.min(0.006, spacing) * (0.4 - snap * 0.15);
  const last = clapLast(s);
  const tailLen = Math.max(0.02, len - last);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    let env = 0;
    s.bursts.forEach((b, k) => {
      if (t >= b) env = Math.max(env, (s.amps[k] as number) * attack(t - b, 0.00015) * Math.exp(-(t - b) / tau));
    });
    if (t >= last) env = Math.max(env, s.tail * attack(t - last, 0.002) * decay(t - last, tailLen, s.tailCurve));
    out[i] = band.process(v.noise()) * env;
  }
}

// ---------------------------------------------------------------- rim

function rim(v: Voice, style: number): void {
  const { sr, out, tone, snap, len } = v;
  const p = new Partials(sr);
  let tick: Biquad;
  let tickAmt: number;
  let tickDec: number;
  let drop: Sweep | null = null;
  let dropRatio = 0;
  if (style === HOUSE) {
    const f = 1700 + tone * 800;
    p.add(f, 0.7);
    p.add(f * 1.52, 0.35);
    tick = Biquad.highpass(3000, 0.7, sr);
    tickAmt = 0.3 + snap;
    tickDec = 0.002;
  } else if (style === TECHNO) {
    const fc = 3000 + tone * 5000;
    p.add(fc * 0.5, 0.3, 0.012);
    tick = Biquad.bandpass(fc, 0.9, sr);
    tickAmt = 3;
    tickDec = 0.0015 + snap * 0.002;
  } else if (style === HIPHOP) {
    const f = 800 + tone * 700;
    drop = new Sweep(f, f * 1.15, 0.004, sr);
    dropRatio = 1;
    p.add(f * 2.76, 0.45);
    p.add(f * 4.1, 0.15, len * 0.4);
    tick = Biquad.bandpass(2500, 0.8, sr);
    tickAmt = 0.4 * snap;
    tickDec = 0.002;
  } else if (style === TRAP) {
    const f = 1900 + tone * 1000;
    p.add(f, 1);
    p.add(f * 1.6, 0.3);
    tick = Biquad.highpass(5000, 0.7, sr);
    tickAmt = snap;
    tickDec = 0.0012;
  } else {
    // 808-style: two bridged-T tones and a click
    const f = 1650 * (0.75 + tone * 0.5);
    p.add(f, 0.8);
    p.add(f * 0.273, 0.5, len * 0.6);
    tick = Biquad.bandpass(4000, 0.9, sr);
    tickAmt = snap;
    tickDec = 0.001;
  }
  const hp = Biquad.highpass(300, 0.7, sr);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    let x = p.next();
    if (drop) x += Math.sin(drop.next()) * dropRatio;
    x = x * decay(t, len) + tick.process(v.noise()) * tickAmt * Math.exp(-t / tickDec);
    out[i] = hp.process(x * attack(t, 0.0001));
  }
}

// ---------------------------------------------------------------- hats

/** the TR-808's six square oscillators (205.3 … 800 Hz), as ratios */
const METAL = [1, 1.4827, 1.8003, 2.546, 2.6303, 3.8967];

interface HatStyle {
  baseMul: number;
  /** amplitude of each of the six squares (noise is ±1) */
  metal: number;
  noise: [number, number];
  hp: [number, number];
  pk: [number, number, number];
  lp: [number, number];
  burst: number;
  curve: number;
}

const HATS: Record<number, HatStyle> = {
  [CLASSIC]: { baseMul: 1, metal: 0.5, noise: [0.45, 0.9], hp: [6800, 6800], pk: [10000, 0.9, 3], lp: [16500, 16500], burst: 0.5, curve: 1 },
  [HOUSE]: { baseMul: 1.1, metal: 0.1, noise: [1, 1], hp: [6500, 8500], pk: [11000, 0.8, 2], lp: [16000, 16500], burst: 0.4, curve: 1 },
  [TECHNO]: { baseMul: 1.15, metal: 1, noise: [0.12, 0.32], hp: [7200, 7200], pk: [8200, 2.2, 6], lp: [15000, 15000], burst: 0.3, curve: 1 },
  [HIPHOP]: { baseMul: 0.95, metal: 0.3, noise: [0.8, 0.8], hp: [5200, 5200], pk: [7500, 0.8, 2], lp: [9000, 12000], burst: 0.3, curve: 1.1 },
  [TRAP]: { baseMul: 1.15, metal: 1, noise: [0.08, 0.23], hp: [7500, 7500], pk: [9500, 1.4, 4], lp: [15500, 15500], burst: 0.2, curve: 1 },
};

function hat(v: Voice, s: HatStyle): void {
  const { sr, out, tone, snap, len } = v;
  const hp = lerp(s.hp, tone);
  const filt = new Chain([Biquad.highpass(hp, BW4[0] as number, sr), Biquad.highpass(hp, BW4[1] as number, sr), Biquad.peak(s.pk[0], s.pk[1], s.pk[2], sr), Biquad.lowpass(lerp(s.lp, tone), 0.707, sr)]);
  const metal = new Partials(sr);
  const base = 205.3 * (0.8 + tone * 0.45) * s.baseMul;
  // metal: the level of each square (their high harmonics, which the filters pass, are weak: 4/πk)
  if (s.metal > 0) for (const r of METAL) metal.addSquare(base * r, s.metal, (f) => filt.gainAt(f, sr) > 1e-3);
  const na = lerp(s.noise, snap);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const env = attack(t, 0.0001) * decay(t, len, s.curve) * (1 + snap * s.burst * Math.exp(-t / 0.002));
    out[i] = filt.process(metal.next() + v.noise() * na) * env;
  }
}

// ---------------------------------------------------------------- cymbals

/** inharmonic cymbal partials between lo and hi Hz (a deterministic spread), each with its own decay */
function cymbalPartials(p: Partials, lo: number, hi: number, count: number, len: number, level: number): void {
  for (let k = 0; k < count; k++) {
    const u = (k * 0.6180339887) % 1;
    const f = lo * Math.pow(hi / lo, u);
    // higher partials ring longer (the shimmer); lower ones die quicker (no clang)
    p.add(f, (level / Math.sqrt(count)) * (0.6 + 0.4 * ((k * 0.4142) % 1)), len * (0.45 + 0.55 * u), k * 1.3);
  }
}

function crash(v: Voice, style: number): void {
  const { sr, out, tone, snap, len } = v;
  const p = new Partials(sr);
  let filt: Chain;
  let noiseAmt = 0.9;
  let ping = 0.8;
  let bloom = 0.0015;
  let curve = 0.9;
  let reverse = false;
  if (style === HOUSE) {
    // ride: a bell over a quieter wash
    const fb = 2300 + tone * 700;
    [1, 1.51, 2.27, 2.98].forEach((r, k) => p.add(fb * r, [0.5, 0.35, 0.25, 0.15][k] as number, len * 0.5));
    filt = new Chain([Biquad.highpass(2500, 0.7, sr), Biquad.lowpass(16000, 0.7, sr)]);
    cymbalPartials(p, 3000, 12000, 24, len, 0.5 + snap * 0.3);
    noiseAmt = 0.25;
    ping = 1.2;
    bloom = 0.0005;
    curve = 1;
  } else if (style === TECHNO) {
    filt = new Chain([Biquad.highpass(3000, BW4[0] as number, sr), Biquad.highpass(3000, BW4[1] as number, sr), Biquad.lowpass(15000, 0.7, sr)]);
    cymbalPartials(p, 3000 + tone * 1000, 13000, 24, len * 4, 0.6);
    noiseAmt = 0.5 + snap * 0.5;
    ping = 0;
    reverse = true;
  } else if (style === HIPHOP) {
    filt = new Chain([Biquad.highpass(1800, 0.7, sr), Biquad.peak(3500, 0.8, 3, sr), Biquad.lowpass(7500, BW4[0] as number, sr), Biquad.lowpass(7500, BW4[1] as number, sr)]);
    cymbalPartials(p, 1500 + tone * 600, 6500, 28, len, 0.7);
    noiseAmt = 0.6 + snap * 0.3;
  } else if (style === TRAP) {
    filt = new Chain([Biquad.highpass(4500, BW4[0] as number, sr), Biquad.highpass(4500, BW4[1] as number, sr), Biquad.peak(9000, 0.8, 2, sr), Biquad.lowpass(17500, 0.7, sr)]);
    cymbalPartials(p, 4000 + tone * 1500, 14000, 24, len, 0.6);
    noiseAmt = 0.6 + snap * 0.4;
    curve = 0.85;
  } else {
    filt = new Chain([Biquad.highpass(3200, BW4[0] as number, sr), Biquad.highpass(3200, BW4[1] as number, sr), Biquad.peak(7500, 0.9, 3, sr), Biquad.lowpass(16000, 0.7, sr)]);
    cymbalPartials(p, 2900 * (0.85 + tone * 0.35), 13500, 28, len, 0.6);
    noiseAmt = 0.6 + snap * 0.4;
  }
  const rel = REVERSE_RELEASE;
  const swell = Math.max(0.02, len);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    let env: number;
    if (reverse) {
      const x = Math.min(1, t / swell);
      env = x * x * (t <= swell ? 1 : 1 - attack(t - swell, rel));
    } else env = attack(t, bloom) * decay(t, len, curve) * (1 + ping * Math.exp(-t / 0.004));
    out[i] = filt.process(p.next() + v.noise() * noiseAmt) * env;
  }
}

// ---------------------------------------------------------------- cowbell

interface BellStyle {
  f: number;
  ratio: number;
  bp: [number, number];
  lp: number;
  /** ≤ 1: the bell is done by the voice's length */
  lenMul: number;
}

const BELLS: Record<number, BellStyle> = {
  [CLASSIC]: { f: 540, ratio: 1.4815, bp: [1800, 0.7], lp: 7000, lenMul: 1 },
  [HOUSE]: { f: 650, ratio: 1.48, bp: [2200, 0.8], lp: 8000, lenMul: 0.5 },
  [TECHNO]: { f: 380, ratio: 1.5, bp: [1500, 0.35], lp: 9000, lenMul: 1 },
  [HIPHOP]: { f: 480, ratio: 1.48, bp: [1400, 0.9], lp: 3500, lenMul: 1 },
  [TRAP]: { f: 540, ratio: 1.48, bp: [2000, 0.7], lp: 8000, lenMul: 1 },
};

function cowbell(v: Voice, s: BellStyle): void {
  const { sr, out, tone, snap, len } = v;
  const f1 = s.f * (0.85 + tone * 0.3);
  const filt = new Chain([Biquad.bandpass(s.bp[0], s.bp[1], sr), Biquad.lowpass(s.lp, 0.7, sr)]);
  const p = new Partials(sr);
  const keep = (f: number) => filt.gainAt(f, sr) > 1e-3;
  // both squares start mid-plateau, together: the bell is at its loudest on the hit (not a beat later)
  p.addSquare(f1, 0.5, keep, Infinity, Math.PI / 2);
  p.addSquare(f1 * s.ratio, 0.5, keep, Infinity, Math.PI / 2);
  const l = len * s.lenMul;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const env = attack(t, 0.0002) * ((0.3 + 0.7 * snap) * Math.exp(-t / 0.008) + decay(t, l) * (1 - snap * 0.35));
    out[i] = filt.process(p.next()) * env;
  }
}

// ---------------------------------------------------------------- shaker

interface ShakerStyle {
  hp: [number, number];
  hp4: boolean;
  lp: [number, number];
  atk: [number, number];
}

const SHAKERS: Record<number, ShakerStyle> = {
  [CLASSIC]: { hp: [4500, 8000], hp4: true, lp: [15000, 15000], atk: [0.003, 0.018] },
  [HOUSE]: { hp: [2200, 4200], hp4: false, lp: [7000, 10000], atk: [0.012, 0.03] },
  [TECHNO]: { hp: [8000, 11000], hp4: true, lp: [17000, 17000], atk: [0.0015, 0.008] },
  [HIPHOP]: { hp: [3000, 3000], hp4: false, lp: [6000, 8000], atk: [0.005, 0.015] },
  [TRAP]: { hp: [6500, 10000], hp4: true, lp: [16500, 16500], atk: [0.001, 0.006] },
};

function shaker(v: Voice, s: ShakerStyle): void {
  const { sr, out, tone, snap, len } = v;
  const hp = lerp(s.hp, tone);
  const filt = new Chain([
    ...(s.hp4 ? [Biquad.highpass(hp, BW4[0] as number, sr), Biquad.highpass(hp, BW4[1] as number, sr)] : [Biquad.highpass(hp, 0.707, sr)]),
    Biquad.lowpass(lerp(s.lp, tone), 0.707, sr),
  ]);
  const atk = Math.min(len * 0.5, s.atk[0] + (1 - snap) * s.atk[1]);
  // the swell peaks at about `atk`: decay that much faster so the end is still 60 dB under the peak
  const depth = 6.9 / (1 - atk / len);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    out[i] = filt.process(v.noise()) * attack(t, atk) * decay(t, len, 1, depth);
  }
}

// ---------------------------------------------------------------- perc

function perc(v: Voice, style: number): void {
  const { sr, out, tone, snap, len } = v;
  const top = bandTop(sr);
  if (style === HOUSE) {
    // bongo: a quick pitch drop, a second mode, a slap
    const f = 250 + tone * 500;
    const a = new Sweep(f, f * (1.5 + snap), 0.015, sr);
    const b = new Sweep(f * 1.58, f * 1.58 * (1.5 + snap), 0.015, sr);
    const slap = Biquad.bandpass(3000, 0.8, sr);
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      const x = (Math.sin(a.next()) + 0.2 * Math.sin(b.next()) * decay(t, len * 0.5)) * decay(t, len) + slap.process(v.noise()) * 0.3 * snap * Math.exp(-t / 0.003);
      out[i] = x * attack(t, 0.0002);
    }
  } else if (style === TECHNO) {
    // metal ping: inharmonic partials, the high ones dying first
    const f = 600 + tone * 1400;
    const p = new Partials(sr);
    [1, 2.41, 3.73, 5.26].forEach((r, k) => p.add(f * r, k === 0 ? 1 : 0.3 + snap * 0.4, len * (1 - k * 0.2)));
    for (let i = 0; i < out.length; i++) out[i] = p.next() * attack(i / sr, 0.0002) * 0.6;
  } else if (style === HIPHOP) {
    // a short wooden knock
    const f = 380 + tone * 300;
    const a = new Sweep(f, f * 1.4, 0.006, sr);
    const p = new Partials(sr);
    p.add(f * 2.3, 0.3, len * 0.4);
    const tick = Biquad.bandpass(2500, 0.9, sr);
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      out[i] = ((Math.sin(a.next()) + p.next()) * decay(t, len) + tick.process(v.noise()) * snap * Math.exp(-t / 0.002)) * attack(t, 0.0002);
    }
  } else if (style === TRAP) {
    // a water-drop "plip": the pitch flies up
    const f0 = 350 + tone * 300;
    const a = new Sweep(f0 * (3 + snap * 2), f0, 0.02, sr);
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      out[i] = Math.sin(a.next()) * decay(t, len) * attack(t, 0.0003);
    }
  } else {
    // two-operator FM blip, its index kept inside the band
    const fc = 300 + tone * 900;
    const fm = fc * 1.41;
    const iMax = Math.max(0, (top - fc) / fm - 2);
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      const idx = Math.min(iMax, (1 + snap * 6) * Math.exp(-t / 0.03));
      out[i] = Math.sin(TWO_PI * fc * t + idx * Math.sin(TWO_PI * fm * t)) * decay(t, len) * attack(t, 0.0002);
    }
  }
}

// ---------------------------------------------------------------- zap / fx

function zap(v: Voice, style: number): void {
  const { sr, out, tone, snap, len } = v;
  const top = bandTop(sr);
  const rel = REVERSE_RELEASE;
  if (style === HOUSE) {
    // laser: an FM chirp, index limited so no sideband leaves the band
    const s = new Sweep(80, 80 + 2500 + tone * 4000, 0.03, sr);
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      const ph = s.next();
      const idx = Math.max(0, Math.min(1 + snap * 3, (top - s.freq) / (0.5 * s.freq) - 2));
      out[i] = Math.sin(ph + idx * Math.sin(ph * 0.5)) * decay(t, len) * attack(t, 0.0003);
    }
  } else if (style === TECHNO || style === HIPHOP || style === TRAP) {
    const f = new Svf();
    const rate = 6 + tone * 8;
    const swell = Math.max(0.02, len);
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      let fc: number;
      let res: number;
      let env: number;
      if (style === TECHNO) {
        // noise through a falling resonant band-pass
        fc = 200 + (3000 + tone * 6000) * Math.exp(-t / Math.max(0.02, len * 0.5));
        res = Math.max(0.06, 0.3 - snap * 0.24);
        env = decay(t, len) * attack(t, 0.0005);
      } else if (style === HIPHOP) {
        // a vinyl scratch: band-passed noise swept back and forth
        const sw = 0.5 - 0.5 * Math.cos(TWO_PI * rate * t);
        fc = 400 + 2600 * sw;
        res = 0.08 + (1 - snap) * 0.1;
        env = (0.4 + 0.6 * sw) * decay(t, len, 1, 8) * attack(t, 0.001);
      } else {
        // a rising swoosh, cut with a short release at its length
        const x = Math.min(1, t / swell);
        fc = 300 + (2000 + tone * 6000) * x * x;
        res = 0.15 + (1 - snap) * 0.2;
        env = x * (t <= swell ? 1 : 1 - attack(t - swell, rel));
      }
      f.process(v.noise(), fc, res, sr);
      out[i] = f.bp * env;
    }
  } else {
    // a sine diving from a few kHz
    const s = new Sweep(60, 60 + 1500 + tone * 3000, 0.01 + (1 - snap) * 0.04, sr);
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      out[i] = Math.sin(s.next()) * decay(t, len) * attack(t, 0.0003);
    }
  }
}

// ---------------------------------------------------------------- Lo-Fi

/**
 * Lo-Fi: the classic voice through a 12-bit, 26 kHz sampler (SP-1200-like) —
 * deliberately dusty, and still band-limited: an anti-alias filter before the
 * rate reduction and a reconstruction filter after it, so the grit is the bit
 * depth, the saturation and the dark top, not aliasing. A little hiss rides on
 * the sound and dies with it.
 */
function lofi(v: Voice): void {
  const { sr, out, tone } = v;
  const rate = 26040;
  const dark = Biquad.lowpass(5500 + tone * 3500, 0.6, sr);
  // 8th-order Butterworth on both sides of the rate reduction (the images of the hold stay 40 dB+ down)
  const aa = new Chain(BW8.map((q) => Biquad.lowpass(rate * 0.42, q, sr)));
  const recon = new Chain(BW8.map((q) => Biquad.lowpass(rate * 0.4, q, sr)));
  const hiss = Biquad.lowpass(5000, 0.7, sr);
  const hp = Biquad.highpass(40, 0.7, sr);
  let pk = 0;
  for (let i = 0; i < out.length; i++) pk = Math.max(pk, Math.abs(out[i] as number));
  const g = pk > 0 ? 1 / pk : 0;
  const step = rate / sr;
  let acc = 1;
  let held = 0;
  let follow = 0;
  const rel = Math.exp(-1 / (0.03 * sr));
  for (let i = 0; i < out.length; i++) {
    // darken, then a gentle cubic soft clip (only a 3rd harmonic, which the anti-alias filter catches)
    const d = Math.max(-1, Math.min(1, dark.process((out[i] as number) * g)));
    const x = aa.process(1.25 * d - 0.25 * d * d * d);
    acc += step;
    if (acc >= 1) {
      acc -= 1;
      held = Math.round(x * 2047) / 2047;
    }
    const a = Math.abs(held);
    follow = a > follow ? a : follow * rel;
    out[i] = hp.process(recon.process(held) + hiss.process(v.noise()) * 0.01 * follow);
  }
}

// ---------------------------------------------------------------- render

/** Shortest buffer a voice needs beyond its length (fixed parts such as a clap's bursts). */
function minLength(voice: DrumVoiceType, style: number): number {
  if (voice === 'clap') return clapLast(CLAPS[style] ?? (CLAPS[CLASSIC] as ClapStyle)) + 0.03;
  return 0.02;
}

export function renderDrumVoice(src: SynthSource, sampleRate: number): Float32Array<ArrayBuffer> {
  const { voice, tone, snap } = src;
  const sr = sampleRate;
  const style = Math.min(LOFI, Math.max(0, Math.round(src.model ?? 0)));
  const base = style === LOFI ? CLASSIC : style;
  const len = Math.max(src.length, minLength(voice, base));
  // the reverse crash and the swoosh swell up to their length, then release
  const release = (voice === 'crash' && base === TECHNO) || (voice === 'zap' && base === TRAP) ? REVERSE_RELEASE : 0;
  const n = Math.max(1, Math.ceil((len + release + END_FADE) * sr));
  const out = new Float64Array(n);
  const rnd = noiseGen(0x51f0 + voice.length * 977 + Math.round(tone * 1000) * 13 + Math.round(snap * 1000) + style * 7919);
  const scale = Math.sqrt(sr / 48000);
  const v: Voice = { sr, out, noise: () => rnd() * scale, tone, snap, len };
  switch (voice) {
    case 'kick':
      kick(v, KICKS[base] as KickStyle);
      break;
    case 'snare':
      snare(v, SNARES[base] as SnareStyle);
      break;
    case 'clap':
      clap(v, CLAPS[base] as ClapStyle);
      break;
    case 'rim':
      rim(v, base);
      break;
    case 'tom':
      tom(v, TOMS[base] as TomStyle);
      break;
    case 'hatClosed':
    case 'hatOpen':
      hat(v, HATS[base] as HatStyle);
      break;
    case 'crash':
      crash(v, base);
      break;
    case 'cowbell':
      cowbell(v, BELLS[base] as BellStyle);
      break;
    case 'shaker':
      shaker(v, SHAKERS[base] as ShakerStyle);
      break;
    case 'perc':
      perc(v, base);
      break;
    case 'zap':
      zap(v, base);
      break;
  }
  if (style === LOFI) lofi(v);
  return finish(out, sr, voice !== 'kick');
}

/**
 * No DC: a 20 Hz high-pass — except on kicks, whose high-pass recovery from the first lobe
 * would lift the next crest over the first. A kick's wave is symmetric (see kick()), but a
 * short, low one is only a few cycles with a net area left: its exact mean comes off as one
 * smooth half-sine over the whole buffer (infrasonic, zero at both ends). Then a raised-cosine
 * fade to exact silence, and the peak at −1 dBFS.
 */
function finish(x: Float64Array, sr: number, highpass: boolean): Float32Array<ArrayBuffer> {
  const n = x.length;
  if (highpass) {
    const hp = Biquad.highpass(20, 0.707, sr);
    for (let i = 0; i < n; i++) x[i] = hp.process(x[i] as number);
  } else if (n > 1) {
    let mean = 0;
    for (let i = 0; i < n; i++) mean += x[i] as number;
    mean /= n;
    // a half-sine with mean 1: π/2 · sin(π i / (n − 1))
    for (let i = 0; i < n; i++) x[i] = (x[i] as number) - mean * (Math.PI / 2) * Math.sin((Math.PI * i) / (n - 1));
  }
  const fade = Math.min(Math.floor(n / 4), Math.round(END_FADE * sr));
  for (let i = 0; i < fade; i++) {
    const k = n - 1 - i;
    x[k] = (x[k] as number) * (0.5 - 0.5 * Math.cos((Math.PI * i) / fade));
  }
  if (n > 0) x[n - 1] = 0;
  let pk = 0;
  for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(x[i] as number));
  const out = new Float32Array(n);
  const g = pk > 1e-9 ? DRUM_PEAK / pk : 0;
  for (let i = 0; i < n; i++) out[i] = (x[i] as number) * g;
  return out;
}

/** Cache key for a rendered voice. */
export function voiceKey(src: SynthSource, sampleRate: number): string {
  return `${src.voice}|${src.model ?? 0}|${src.tone.toFixed(3)}|${src.snap.toFixed(3)}|${src.length.toFixed(3)}|${sampleRate}`;
}
