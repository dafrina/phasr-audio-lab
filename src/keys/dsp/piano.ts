/**
 * Keyforge piano engine — modal string model.
 *
 * Each note is a bank of exponentially decaying complex resonators, one per
 * string partial, driven by a smooth hammer force pulse:
 *
 *  - Stiff-string inharmonicity: f_k = k·f1·√((1+B·k²)/(1+B)), with B rising
 *    towards the treble (and slightly in the low bass), plus a Railsback-style
 *    stretch of the tuning.
 *  - Hammer: the excitation spectrum depends on velocity (harder hammer felt
 *    → brighter), strike position (comb notch near k ≈ 1/x0) and pitch.
 *  - Strings: the lower partials get two or three resonators (coupled
 *    unison strings / polarisations) slightly detuned with different decay
 *    rates. Their sum gives real beating and the characteristic piano
 *    "double decay": a fast prompt sound followed by a long aftersound that
 *    keeps a gentle beat.
 *  - Losses: per-partial decay grows with frequency² (high partials die
 *    first), the fundamental's T60 follows a measured-style curve from ~20 s
 *    in the bass to <1 s at the top.
 *  - Dampers: key release adds strong damping (less effective in the bass),
 *    the top ~20 keys have no dampers, and the felt touching the string
 *    makes a soft noise. The sustain pedal lifts all dampers.
 *  - Soundboard: a small bank of fixed body modes (driven by the hammer
 *    knock and the strings) and 12 undamped "sympathetic strings" (combs
 *    tuned to C2…B2) that bloom when the pedal is down.
 *
 * A restrike of a sounding note hits the same string again (state is kept
 * and the new excitation adds to it), as on a real piano.
 */
import {
  BEND_SEMITONES,
  DelayLine,
  HeldIds,
  LN_1000,
  MAX_BLOCK,
  Smoother,
  TWO_PI,
  ToneFilter,
  clamp,
  hash01,
  interpTable,
  midiToHz,
  panGains,
  type KeysEngine,
} from './common';
import { allocateVoice } from '../../synth/dsp/voiceAllocator';
import { Noise } from '../../synth/dsp/oscillator';

export const PIANO_MAX_PARTIALS = 96;
/** partials 1..DOUBLE_PARTIALS get a prompt and an aftersound resonator */
const DOUBLE_PARTIALS = 24;
/** partials 1..TRIPLE_PARTIALS also get a second, detuned aftersound resonator */
const TRIPLE_PARTIALS = 12;
const MAX_RES = PIANO_MAX_PARTIALS + DOUBLE_PARTIALS + TRIPLE_PARTIALS;
/** share of the second aftersound string (beating in the tail) */
const AFTER2_SHARE = 0.07;
const POLYPHONY = 32;
/** keys at or above this note have no dampers */
export const PIANO_NO_DAMPER_NOTE = 89;
/** share of the initial amplitude in the fast "prompt" component */
const PROMPT_SHARE = 0.7;
/** prompt component decays this many times faster than the aftersound */
const PROMPT_RATE = 3.6;
/** a resonator is dropped below this energy (≈ −94 dBFS amplitude) */
const DEAD_ENERGY = 4e-10;
const LEVEL = 0.25;

/** fundamental T60 (seconds) by MIDI note, before the Sustain multiplier */
const FUND_T60: readonly (readonly [number, number])[] = [
  [21, 20],
  [36, 16],
  [48, 13],
  [60, 10],
  [72, 6],
  [84, 4],
  [96, 2.2],
  [108, 1.2],
];

export interface PianoParams {
  brightness: number;
  hardness: number;
  hammerNoise: number;
  strike: number;
  sustain: number;
  damping: number;
  unison: number;
  inharm: number;
  stretch: number;
  damper: number;
  releaseNoise: number;
  resonance: number;
  body: number;
  tone: number;
  width: number;
  velCurve: number;
  master: number;
}

// ---------------------------------------------------------------------------
// Pure model functions (exported for tests)
// ---------------------------------------------------------------------------

/** inharmonicity coefficient B for a note (inharm = 1 → typical grand) */
export function inharmonicityB(note: number, inharm: number): number {
  const log = note >= 35 ? -4 + 0.0235 * (note - 35) : -4 + 0.01 * (35 - note);
  return Math.pow(10, log) * inharm;
}

/** tuning stretch in cents (Railsback-like: flat bass, sharp treble) */
export function stretchCents(note: number, stretch: number): number {
  const d = clamp((note - 64) / 44, -1.2, 1.2);
  return stretch * 30 * d * d * d;
}

/** tuned fundamental (Hz) of a note */
export function pianoFundamental(note: number, stretch: number): number {
  return midiToHz(note) * Math.pow(2, stretchCents(note, stretch) / 1200);
}

/** frequency of partial k of a stiff string with fundamental f1 */
export function partialFrequency(f1: number, k: number, B: number): number {
  return k * f1 * Math.sqrt((1 + B * k * k) / (1 + B));
}

/** aftersound T60 of the fundamental (seconds) */
export function fundamentalT60(note: number, sustain: number): number {
  return interpTable(FUND_T60, note) * sustain;
}

/** frequency-dependent loss coefficient (1/s per Hz²) */
function lossB3(damping: number): number {
  return 6e-7 * (0.25 + 1.5 * damping);
}

/** T60 of a partial at frequency f for a note whose fundamental is f1 */
export function partialT60(note: number, f: number, f1: number, p: Pick<PianoParams, 'sustain' | 'damping'>): number {
  const s1 = LN_1000 / fundamentalT60(note, p.sustain);
  const s = s1 + lossB3(p.damping) * Math.max(0, f * f - f1 * f1);
  return LN_1000 / s;
}

/** relative strike amplitude of partial k (before energy normalisation) */
export function hammerSpectrum(note: number, k: number, f: number, f1: number, vel: number, p: Pick<PianoParams, 'brightness' | 'hardness' | 'strike'>): number {
  const velTone = 1 - p.hardness + p.hardness * Math.pow(vel, 1.5);
  const b = clamp(p.brightness * (0.3 + velTone), 0, 1.4);
  const fc = f1 + (350 + 4200 * b * b) * Math.pow(f1 / 262, 0.45);
  const hammer = 1 / (1 + (f / fc) * (f / fc));
  // strike point: 1/8 in the mid range, closer to the agraffe in the treble
  const x0 = p.strike * (1 - 0.3 * clamp((note - 60) / 48, 0, 1));
  // the hammer's finite width keeps the notch from being complete
  const comb = 0.22 + 0.78 * Math.abs(Math.sin(Math.PI * k * x0));
  const tilt = Math.pow(k, -0.35);
  // soundboard radiates the lowest fundamentals poorly
  const board = 1 / (1 + (70 / f) * (70 / f));
  const air = 1 / (1 + (f / 9000) * (f / 9000));
  return hammer * comb * tilt * board * air;
}

/** detune (cents) between the two strings of partial k */
function stringDetune(note: number, k: number, unison: number): number {
  return unison * (0.55 + 0.9 * hash01(note, k));
}

// ---------------------------------------------------------------------------

class PianoVoice {
  active = false;
  note = 60;
  order = 0;
  vel = 0;
  readonly held = new HeldIds();
  /** keys are up while the pedal is down */
  sustained = false;
  damped = false;
  /** whether the keys are up (counts as releasing for voice stealing) */
  released = false;
  /** number of live resonators */
  n = 0;
  readonly pid = new Int32Array(MAX_RES);
  readonly re = new Float64Array(MAX_RES);
  readonly im = new Float64Array(MAX_RES);
  readonly a = new Float64Array(MAX_RES);
  readonly b = new Float64Array(MAX_RES);
  readonly gin = new Float64Array(MAX_RES);
  // hammer force pulse: g(j) = j·e^{-j/τ} / norm
  pulsePos = 0;
  pulseLen = 0;
  pulseTau = 1;
  pulseNorm = 1;
  // stealing
  killing = false;
  fade = 1;
  fadeStep = 0;
  pendingNote = -1;
  pendingVel = 0;
  pendingId = 0;
  gAL = 0.7;
  gAR = 0.7;
  gBL = 0.7;
  gBR = 0.7;

  get resonating(): boolean {
    return this.active && !this.killing;
  }
}

/** resonator id: partial k (1-based), string s (0 = prompt, 1 = aftersound / single) */
/** resonator id: partial k (1-based), string s (0 = prompt, 1 = aftersound / single, 2 = second aftersound) */
const pidOf = (k: number, s: number) => k * 4 + s;
const S_PROMPT = 0;
const S_AFTER = 1;
const S_AFTER2 = 2;

const BODY_MODES: readonly (readonly [number, number, number])[] = [
  // Hz, T60 s, gain
  [72, 0.2, 1],
  [118, 0.16, 0.8],
  [181, 0.13, 0.7],
  [243, 0.11, 0.55],
  [330, 0.1, 0.45],
  [440, 0.08, 0.35],
  [590, 0.07, 0.3],
  [820, 0.05, 0.22],
  [1150, 0.04, 0.15],
  [1700, 0.03, 0.1],
];
const SYMPATHETIC_NOTES = 12;
const SYMPATHETIC_BASE = 36;

export class PianoEngine implements KeysEngine {
  private readonly sr: number;
  private p: PianoParams;
  private readonly voices: PianoVoice[] = [];
  private orderCounter = 0;
  private pedal = false;
  private bendRatio = 1;
  private readonly bufA = new Float64Array(MAX_BLOCK);
  private readonly bufB = new Float64Array(MAX_BLOCK);
  private readonly mixL = new Float64Array(MAX_BLOCK);
  private readonly mixR = new Float64Array(MAX_BLOCK);
  private readonly pulse = new Float64Array(MAX_BLOCK);
  private readonly tmpRe = new Float64Array(4 * PIANO_MAX_PARTIALS + 4);
  private readonly tmpIm = new Float64Array(4 * PIANO_MAX_PARTIALS + 4);
  private readonly tmpHas = new Uint8Array(4 * PIANO_MAX_PARTIALS + 4);
  private readonly pan = { l: 0, r: 0 };
  // soundboard
  private readonly bodyRe = new Float64Array(BODY_MODES.length);
  private readonly bodyIm = new Float64Array(BODY_MODES.length);
  private readonly bodyA = new Float64Array(BODY_MODES.length);
  private readonly bodyB = new Float64Array(BODY_MODES.length);
  private knockPending = 0;
  private thumpEnv = 0;
  private thumpDecay = 0;
  private readonly noise = new Noise(0x51a7e);
  // sympathetic strings
  private readonly combs: DelayLine[] = [];
  private readonly combDelay = new Float64Array(SYMPATHETIC_NOTES);
  private readonly combG = new Float64Array(SYMPATHETIC_NOTES);
  private readonly combLp = new Float64Array(SYMPATHETIC_NOTES);
  private readonly combDamp = 0.35;
  private readonly sympWet = new Smoother(0);
  private readonly lidL = new ToneFilter();
  private readonly lidR = new ToneFilter();
  private readonly master = new Smoother(0.8);

  constructor(sampleRate: number, params: PianoParams) {
    this.sr = sampleRate;
    this.p = params;
    for (let i = 0; i < POLYPHONY; i++) this.voices.push(new PianoVoice());
    for (let m = 0; m < BODY_MODES.length; m++) {
      const [f, t60] = BODY_MODES[m] as readonly [number, number, number];
      const r = Math.exp(-LN_1000 / (t60 * sampleRate));
      this.bodyA[m] = r * Math.cos((TWO_PI * f) / sampleRate);
      this.bodyB[m] = r * Math.sin((TWO_PI * f) / sampleRate);
    }
    // the in-loop one-pole adds ≈ damp/(1-damp) samples of delay; compensate so the combs stay in tune
    const lpDelay = this.combDamp / (1 - this.combDamp);
    for (let c = 0; c < SYMPATHETIC_NOTES; c++) {
      const period = sampleRate / midiToHz(SYMPATHETIC_BASE + c);
      this.combs.push(new DelayLine(Math.ceil(period) + 4));
      this.combDelay[c] = period - lpDelay;
      this.combG[c] = Math.pow(10, (-3 * period) / sampleRate / 4.5);
    }
    this.thumpDecay = Math.exp(-1 / (0.004 * sampleRate));
    this.sympWet.setTime(0.25, sampleRate);
    this.master.setTime(0.02, sampleRate);
    this.setParams(params as unknown as Record<string, number>);
    this.master.value = this.master.target;
  }

  setParams(raw: Record<string, number>): void {
    const prev = this.p;
    const p = raw as unknown as PianoParams;
    this.p = p;
    this.lidL.set(p.tone, this.sr, 0.6);
    this.lidR.set(p.tone, this.sr, 0.6);
    this.master.target = p.master;
    const retune =
      prev.sustain !== p.sustain || prev.damping !== p.damping || prev.unison !== p.unison || prev.inharm !== p.inharm || prev.stretch !== p.stretch || prev.damper !== p.damper;
    for (const v of this.voices) {
      if (!v.active) continue;
      if (retune) this.updateCoefs(v);
      this.updatePan(v);
    }
  }

  setBend(value: number): void {
    const r = Math.pow(2, (clamp(value, -1, 1) * BEND_SEMITONES) / 12);
    if (r === this.bendRatio) return;
    this.bendRatio = r;
    for (const v of this.voices) if (v.active) this.updateCoefs(v);
  }

  setSustain(on: boolean): void {
    this.pedal = on;
    if (on) return;
    for (const v of this.voices) {
      if (v.active && v.sustained) {
        v.sustained = false;
        this.damp(v);
      }
    }
  }

  noteOn(id: number, note: number, velocity: number): void {
    const vel = clamp(velocity, 0, 1);
    // restrike: the hammer hits the string that is still vibrating
    for (const v of this.voices) {
      if (v.resonating && v.note === note) {
        v.held.add(id);
        v.sustained = false;
        v.released = false;
        v.order = ++this.orderCounter;
        this.strike(v, vel);
        return;
      }
    }
    const { index, steal } = allocateVoice(this.voices, POLYPHONY);
    const v = this.voices[index] as PianoVoice;
    if (steal && v.active) {
      v.killing = true;
      v.fadeStep = 1 / Math.max(1, 0.004 * this.sr);
      v.pendingNote = note;
      v.pendingVel = vel;
      v.pendingId = id;
      v.held.clear();
      v.order = ++this.orderCounter;
      v.released = false;
      return;
    }
    this.startVoice(v, id, note, vel);
  }

  private startVoice(v: PianoVoice, id: number, note: number, vel: number): void {
    v.active = true;
    v.killing = false;
    v.fade = 1;
    v.pendingNote = -1;
    v.note = note;
    v.n = 0;
    v.held.clear();
    v.held.add(id);
    v.sustained = false;
    v.released = false;
    v.order = ++this.orderCounter;
    this.updatePan(v);
    this.strike(v, vel);
  }

  noteOff(id: number): void {
    for (const v of this.voices) {
      if (!v.active || !v.held.remove(id) || !v.held.empty) continue;
      v.released = true;
      if (this.pedal) v.sustained = true;
      else this.damp(v);
    }
  }

  allNotesOff(): void {
    for (const v of this.voices) {
      if (!v.active) continue;
      v.held.clear();
      v.sustained = false;
      v.released = true;
      if (v.pendingNote >= 0) v.pendingNote = -1;
      this.damp(v);
    }
  }

  panic(): void {
    for (const v of this.voices) {
      v.active = false;
      v.killing = false;
      v.pendingNote = -1;
      v.n = 0;
      v.held.clear();
    }
    this.pedal = false;
    this.bodyRe.fill(0);
    this.bodyIm.fill(0);
    this.knockPending = 0;
    this.thumpEnv = 0;
    for (const c of this.combs) c.clear();
    this.combLp.fill(0);
  }

  activeVoices(): number {
    let n = 0;
    for (const v of this.voices) if (v.active) n++;
    return n;
  }

  // -------------------------------------------------------------------------

  private updatePan(v: PianoVoice): void {
    const w = this.p.width;
    const center = w * 0.75 * clamp((v.note - 64) / 40, -1, 1);
    panGains(center - 0.15 * w, this.pan);
    v.gAL = this.pan.l;
    v.gAR = this.pan.r;
    panGains(center + 0.15 * w, this.pan);
    v.gBL = this.pan.l;
    v.gBR = this.pan.r;
  }

  private damp(v: PianoVoice): void {
    if (v.note >= PIANO_NO_DAMPER_NOTE || v.damped || v.killing) return;
    v.damped = true;
    this.updateCoefs(v);
    // the felt touching the string
    this.knockPending += this.p.releaseNoise * 0.18 * (0.3 + 0.7 * v.vel);
  }

  /** (Re)compute frequency and decay of every live resonator from the current parameters. */
  private updateCoefs(v: PianoVoice): void {
    const p = this.p;
    const note = v.note;
    const f1 = pianoFundamental(note, p.stretch);
    const B = inharmonicityB(note, p.inharm);
    // damper: fast in the treble, slower and growlier in the bass
    const bass = clamp((60 - note) / 40, 0, 1);
    const damperT60 = (0.07 + 0.45 * bass) * (1.65 - p.damper);
    const damperS = v.damped ? LN_1000 / damperT60 : 0;
    const sr = this.sr;
    const nyq = sr * 0.47;
    for (let r = 0; r < v.n; r++) {
      const id = v.pid[r] as number;
      const k = id >> 2;
      const s = id & 3;
      let f = partialFrequency(f1, k, B);
      const t60 = partialT60(note, f, f1, p);
      let sigma = LN_1000 / t60;
      if (k <= DOUBLE_PARTIALS) {
        const d = stringDetune(note, k, p.unison) / 2400;
        if (s === S_PROMPT) {
          f *= Math.pow(2, -d);
          sigma *= PROMPT_RATE;
        } else if (s === S_AFTER) f *= Math.pow(2, d);
        else {
          f *= Math.pow(2, d * (0.2 + 0.6 * hash01(note + 101, k)));
          sigma *= 1.15;
        }
      }
      sigma += damperS * (0.6 + 0.4 * Math.min(1, f / 600));
      f *= this.bendRatio;
      if (f > nyq) f = nyq;
      const rad = Math.exp(-sigma / sr);
      const w = (TWO_PI * f) / sr;
      v.a[r] = rad * Math.cos(w);
      v.b[r] = rad * Math.sin(w);
    }
  }

  /** Hammer strike: (re)build the resonator set, keeping the state of partials still ringing. */
  private strike(v: PianoVoice, vel: number): void {
    const p = this.p;
    const note = v.note;
    const sr = this.sr;
    v.vel = vel;
    v.damped = false;
    const f1 = pianoFundamental(note, p.stretch);
    const B = inharmonicityB(note, p.inharm);
    // keep existing oscillation
    this.tmpHas.fill(0);
    for (let r = 0; r < v.n; r++) {
      const id = v.pid[r] as number;
      this.tmpHas[id] = 1;
      this.tmpRe[id] = v.re[r] as number;
      this.tmpIm[id] = v.im[r] as number;
    }
    // partial amplitudes, normalised to equal energy per note
    const fmax = Math.min(sr * 0.45, 17000);
    let count = 0;
    let energy = 0;
    const amps = this.bufA; // scratch (≤ PIANO_MAX_PARTIALS < MAX_BLOCK)
    for (let k = 1; k <= PIANO_MAX_PARTIALS; k++) {
      const f = partialFrequency(f1, k, B);
      if (f > fmax) break;
      const a = hammerSpectrum(note, k, f, f1, vel, p);
      amps[k - 1] = a;
      energy += a * a;
      count = k;
    }
    const bass = clamp((60 - note) / 40, 0, 1);
    const level = (LEVEL * Math.pow(Math.max(vel, 1e-3), p.velCurve) * (1 + 0.25 * bass)) / Math.sqrt(Math.max(energy, 1e-12));
    let n = 0;
    const peak = (amps[0] as number) * level;
    for (let k = 1; k <= count; k++) {
      const a = (amps[k - 1] as number) * level;
      // inaudible partial that isn't ringing already: skip
      if (a < peak * 1e-4 && !this.tmpHas[pidOf(k, S_AFTER)]) continue;
      const triple = k <= TRIPLE_PARTIALS;
      const double = k <= DOUBLE_PARTIALS;
      for (let s = double ? S_PROMPT : S_AFTER; s <= (triple ? S_AFTER2 : S_AFTER); s++) {
        if (n >= MAX_RES) break;
        const id = pidOf(k, s);
        v.pid[n] = id;
        v.re[n] = this.tmpHas[id] ? (this.tmpRe[id] as number) : 0;
        v.im[n] = this.tmpHas[id] ? (this.tmpIm[id] as number) : 0;
        const after = 1 - PROMPT_SHARE - (triple ? AFTER2_SHARE : 0);
        v.gin[n] = !double ? a : s === S_PROMPT ? a * PROMPT_SHARE : s === S_AFTER ? a * after : a * AFTER2_SHARE;
        n++;
      }
    }
    v.n = n;
    this.updateCoefs(v);
    // hammer contact: shorter and sharper for loud notes and high strings
    const tauSec = (0.00005 + 0.00022 * (1 - vel) * (1 - vel)) * Math.pow(262 / f1, 0.2);
    const tau = Math.max(0.6, tauSec * sr);
    v.pulseTau = tau;
    v.pulseLen = Math.ceil(9 * tau) + 1;
    let norm = 0;
    for (let j = 0; j < v.pulseLen; j++) norm += j * Math.exp(-j / tau);
    v.pulseNorm = 1 / norm;
    v.pulsePos = 0;
    // hammer knock into the soundboard
    this.knockPending += p.hammerNoise * Math.pow(vel, 1.3) * 0.5 * (1 + 0.5 * bass);
    this.thumpEnv += p.hammerNoise * vel * vel * 0.02;
  }

  // -------------------------------------------------------------------------

  private renderVoice(v: PianoVoice, n: number): void {
    const A = this.bufA;
    const Bf = this.bufB;
    A.fill(0, 0, n);
    Bf.fill(0, 0, n);
    const hasPulse = v.pulsePos < v.pulseLen;
    if (hasPulse) {
      const pulse = this.pulse;
      for (let i = 0; i < n; i++) {
        const j = v.pulsePos + i;
        pulse[i] = j < v.pulseLen ? j * Math.exp(-j / v.pulseTau) * v.pulseNorm : 0;
      }
      v.pulsePos += n;
    }
    const pulse = this.pulse;
    let r = 0;
    while (r < v.n) {
      let re = v.re[r] as number;
      let im = v.im[r] as number;
      const a = v.a[r] as number;
      const b = v.b[r] as number;
      const dst = ((v.pid[r] as number) & 3) === S_AFTER ? Bf : A;
      if (hasPulse) {
        const g = v.gin[r] as number;
        for (let i = 0; i < n; i++) {
          const nr = a * re - b * im + g * (pulse[i] as number);
          im = b * re + a * im;
          re = nr;
          dst[i] = (dst[i] as number) + im;
        }
      } else {
        for (let i = 0; i < n; i++) {
          const nr = a * re - b * im;
          im = b * re + a * im;
          re = nr;
          dst[i] = (dst[i] as number) + im;
        }
      }
      if (!hasPulse && re * re + im * im < DEAD_ENERGY) {
        // swap-remove the dead resonator
        const last = v.n - 1;
        v.pid[r] = v.pid[last] as number;
        v.re[r] = v.re[last] as number;
        v.im[r] = v.im[last] as number;
        v.a[r] = v.a[last] as number;
        v.b[r] = v.b[last] as number;
        v.gin[r] = v.gin[last] as number;
        v.n = last;
        continue;
      }
      v.re[r] = re;
      v.im[r] = im;
      r++;
    }
    const L = this.mixL;
    const R = this.mixR;
    if (v.killing) {
      let fade = v.fade;
      for (let i = 0; i < n; i++) {
        fade = Math.max(0, fade - v.fadeStep);
        const x = A[i] as number;
        const y = Bf[i] as number;
        L[i] = (L[i] as number) + (x * v.gAL + y * v.gBL) * fade;
        R[i] = (R[i] as number) + (x * v.gAR + y * v.gBR) * fade;
      }
      v.fade = fade;
      if (fade <= 0) {
        v.active = false;
        v.killing = false;
        v.n = 0;
        if (v.pendingNote >= 0) this.startVoice(v, v.pendingId, v.pendingNote, v.pendingVel);
      }
      return;
    }
    for (let i = 0; i < n; i++) {
      const x = A[i] as number;
      const y = Bf[i] as number;
      L[i] = (L[i] as number) + x * v.gAL + y * v.gBL;
      R[i] = (R[i] as number) + x * v.gAR + y * v.gBR;
    }
    if (v.n === 0 && !hasPulse) {
      v.active = false;
      v.held.clear();
    }
  }

  render(outL: Float32Array, outR: Float32Array, offset: number, count: number): void {
    const n = count;
    const L = this.mixL;
    const R = this.mixR;
    L.fill(0, 0, n);
    R.fill(0, 0, n);
    for (const v of this.voices) if (v.active) this.renderVoice(v, n);

    const p = this.p;
    const bodyFeed = 0.06 * p.body;
    const modes = BODY_MODES.length;
    this.sympWet.target = p.resonance * (this.pedal ? 0.5 : 0.06);
    const noise = this.noise;
    for (let i = 0; i < n; i++) {
      const l = L[i] as number;
      const r = R[i] as number;
      const mono = 0.5 * (l + r);
      // --- soundboard / hammer knock
      let knock = 0;
      if (i === 0 && this.knockPending) {
        knock = this.knockPending;
        this.knockPending = 0;
      }
      let thump = 0;
      if (this.thumpEnv > 1e-7) {
        thump = noise.next() * this.thumpEnv;
        this.thumpEnv *= this.thumpDecay;
      }
      const bin = knock + mono * bodyFeed + thump * 0.3;
      let bodyL = 0;
      let bodyR = 0;
      for (let m = 0; m < modes; m++) {
        const re = this.bodyRe[m] as number;
        const im = this.bodyIm[m] as number;
        const a = this.bodyA[m] as number;
        const b = this.bodyB[m] as number;
        const nr = a * re - b * im + bin;
        const ni = b * re + a * im;
        this.bodyRe[m] = nr;
        this.bodyIm[m] = ni;
        const g = (BODY_MODES[m] as readonly [number, number, number])[2] * ni;
        if (m & 1) bodyR += g;
        else bodyL += g;
      }
      // body modes are narrow; scale so a forte knock is a soft thud
      const bodyGain = 0.035;
      // --- sympathetic strings
      const wet = this.sympWet.next();
      let sL = 0;
      let sR = 0;
      if (wet > 1e-4) {
        const cin = mono * 0.03;
        for (let c = 0; c < SYMPATHETIC_NOTES; c++) {
          const line = this.combs[c] as DelayLine;
          const x = line.read(this.combDelay[c] as number);
          const lp = x + ((this.combLp[c] as number) - x) * this.combDamp;
          this.combLp[c] = lp;
          const y = cin + (this.combG[c] as number) * lp;
          line.write(y);
          if (c & 1) sR += y;
          else sL += y;
        }
      }
      const outl = l + (bodyL * 0.8 + bodyR * 0.2) * bodyGain + thump * 0.15 + sL * wet;
      const outr = r + (bodyR * 0.8 + bodyL * 0.2) * bodyGain + thump * 0.15 + sR * wet;
      const g = this.master.next();
      outL[offset + i] = (outL[offset + i] as number) + this.lidL.process(outl) * g;
      outR[offset + i] = (outR[offset + i] as number) + this.lidR.process(outr) * g;
    }
  }
}
