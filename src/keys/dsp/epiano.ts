/**
 * Keyforge electric piano — tine model.
 *
 * A struck tine is a clamped-free cantilever: an almost pure fundamental
 * plus strongly inharmonic, fast-decaying overtones (ratios 6.27 and 17.55
 * of a clamped-free beam) that make the metallic "bell" attack. The tonebar
 * it is bolted to rings slightly detuned and longer, giving the slow
 * beating and the long tail.
 *
 * The sound is picked up electromagnetically: the output is the time
 * derivative of the magnetic flux, which depends non-linearly and
 * asymmetrically on tine displacement. Small swings stay clean; hard hits
 * drive the tine far into the pickup's field and produce the growling
 * even/odd harmonics ("bark"). Everything after that — tremolo/auto-pan,
 * preamp drive and tone — is post-processing on the summed signal.
 */
import {
  BEND_SEMITONES,
  DcBlocker,
  HeldIds,
  LN_1000,
  MAX_BLOCK,
  Smoother,
  TWO_PI,
  ToneFilter,
  clamp,
  fastTanh,
  interpTable,
  midiToHz,
  panGains,
  type KeysEngine,
} from './common';
import { allocateVoice } from '../../synth/dsp/voiceAllocator';

const POLYPHONY = 24;
const LEVEL = 0.3;
/** clamped-free beam mode ratios */
export const TINE_MODE_2 = 6.267;
export const TINE_MODE_3 = 17.55;
const TINE_T60: readonly (readonly [number, number])[] = [
  [28, 9],
  [48, 6],
  [60, 4.5],
  [72, 3],
  [88, 1.5],
  [100, 0.8],
];

export interface EPianoParams {
  bell: number;
  bark: number;
  decay: number;
  hardness: number;
  damper: number;
  tremRate: number;
  tremDepth: number;
  drive: number;
  tone: number;
  velCurve: number;
  master: number;
}

export function tineT60(note: number, decay: number): number {
  return interpTable(TINE_T60, note) * decay;
}

/** Pickup flux as a function of tine displacement; asymmetric soft curve. */
export function pickupCurve(x: number, bark: number): number {
  const k = 0.6 + 2.6 * bark;
  const o = 0.08 + 0.35 * bark;
  const t0 = fastTanh(k * o);
  // normalised so the small-signal slope is 1
  const slope = k * (1 - t0 * t0);
  return (fastTanh(k * (x + o)) - t0) / slope;
}

/** resonator index meaning */
const R_TINE = 0;
const R_BAR = 1;
const R_BELL = 2;
const R_PING = 3;
const NRES = 4;

class EpVoice {
  active = false;
  note = 60;
  order = 0;
  vel = 0;
  readonly held = new HeldIds();
  sustained = false;
  released = false;
  damped = false;
  readonly re = new Float64Array(NRES);
  readonly im = new Float64Array(NRES);
  readonly a = new Float64Array(NRES);
  readonly b = new Float64Array(NRES);
  readonly g = new Float64Array(NRES);
  /** tine swing into the pickup */
  drive = 0.5;
  /** output gain (dynamics), normalised by pickup drive */
  out = 0;
  flux1 = 0;
  /** derivative normalisation 1/(2·sin(πf0/sr)) */
  diffNorm = 1;
  killing = false;
  fade = 1;
  fadeStep = 0;
  pendingNote = -1;
  pendingVel = 0;
  pendingId = 0;
  gl = 0.7;
  gr = 0.7;
  silentBlocks = 0;
}

export class EPianoEngine implements KeysEngine {
  private readonly sr: number;
  private p: EPianoParams;
  private readonly voices: EpVoice[] = [];
  private orderCounter = 0;
  private pedal = false;
  private bendRatio = 1;
  private readonly buf = new Float64Array(MAX_BLOCK);
  private readonly mixL = new Float64Array(MAX_BLOCK);
  private readonly mixR = new Float64Array(MAX_BLOCK);
  private readonly pan = { l: 0, r: 0 };
  private tremPhase = 0;
  private readonly tremDepth = new Smoother(0);
  private readonly drive = new Smoother(0);
  private readonly toneL = new ToneFilter();
  private readonly toneR = new ToneFilter();
  private readonly dcL = new DcBlocker();
  private readonly dcR = new DcBlocker();
  private readonly master = new Smoother(0.8);

  constructor(sampleRate: number, params: EPianoParams) {
    this.sr = sampleRate;
    this.p = params;
    for (let i = 0; i < POLYPHONY; i++) this.voices.push(new EpVoice());
    this.tremDepth.setTime(0.03, sampleRate);
    this.drive.setTime(0.03, sampleRate);
    this.master.setTime(0.02, sampleRate);
    this.dcL.setCutoff(12, sampleRate);
    this.dcR.setCutoff(12, sampleRate);
    this.setParams(params as unknown as Record<string, number>);
    this.master.value = this.master.target;
    this.tremDepth.value = this.tremDepth.target;
    this.drive.value = this.drive.target;
  }

  setParams(raw: Record<string, number>): void {
    const prev = this.p;
    const p = raw as unknown as EPianoParams;
    this.p = p;
    this.toneL.set(p.tone, this.sr, 0.7);
    this.toneR.set(p.tone, this.sr, 0.7);
    this.master.target = p.master;
    this.tremDepth.target = p.tremDepth;
    this.drive.target = p.drive;
    if (prev.decay !== p.decay || prev.damper !== p.damper) for (const v of this.voices) if (v.active) this.updateCoefs(v);
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
    for (const v of this.voices) {
      if (v.active && !v.killing && v.note === note) {
        // the hammer strikes the still-vibrating tine again
        v.held.add(id);
        v.sustained = false;
        v.released = false;
        v.order = ++this.orderCounter;
        this.strike(v, vel);
        return;
      }
    }
    const { index, steal } = allocateVoice(this.voices, POLYPHONY);
    const v = this.voices[index] as EpVoice;
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

  private startVoice(v: EpVoice, id: number, note: number, vel: number): void {
    v.active = true;
    v.killing = false;
    v.fade = 1;
    v.pendingNote = -1;
    v.note = note;
    v.re.fill(0);
    v.im.fill(0);
    v.flux1 = pickupCurve(0, this.p.bark);
    v.held.clear();
    v.held.add(id);
    v.sustained = false;
    v.released = false;
    v.silentBlocks = 0;
    v.order = ++this.orderCounter;
    panGains(0.35 * clamp((note - 64) / 30, -1, 1), this.pan);
    v.gl = this.pan.l;
    v.gr = this.pan.r;
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
      v.pendingNote = -1;
      this.damp(v);
    }
  }

  panic(): void {
    for (const v of this.voices) {
      v.active = false;
      v.killing = false;
      v.pendingNote = -1;
      v.held.clear();
    }
    this.pedal = false;
  }

  activeVoices(): number {
    let n = 0;
    for (const v of this.voices) if (v.active) n++;
    return n;
  }

  private damp(v: EpVoice): void {
    if (v.damped || v.killing) return;
    v.damped = true;
    this.updateCoefs(v);
  }

  private updateCoefs(v: EpVoice): void {
    const sr = this.sr;
    const f0 = midiToHz(v.note) * this.bendRatio;
    const t60 = tineT60(v.note, this.p.decay);
    const bass = clamp((60 - v.note) / 36, 0, 1);
    const damperS = v.damped ? LN_1000 / ((0.06 + 0.2 * bass) * (1.7 - this.p.damper)) : 0;
    const nyq = sr * 0.45;
    const set = (i: number, f: number, t: number) => {
      const s = LN_1000 / t + damperS;
      const r = Math.exp(-s / sr);
      const w = (TWO_PI * Math.min(f, nyq)) / sr;
      v.a[i] = r * Math.cos(w);
      v.b[i] = r * Math.sin(w);
    };
    set(R_TINE, f0, t60);
    set(R_BAR, f0 * 1.0011, t60 * 1.9);
    set(R_BELL, f0 * TINE_MODE_2, clamp(0.35 * Math.pow(262 / f0, 0.5), 0.05, 0.6));
    set(R_PING, f0 * TINE_MODE_3, clamp(0.09 * Math.pow(262 / f0, 0.5), 0.015, 0.15));
    v.diffNorm = 1 / (2 * Math.sin((Math.PI * Math.min(f0, nyq)) / sr));
  }

  private strike(v: EpVoice, vel: number): void {
    const p = this.p;
    v.vel = vel;
    v.damped = false;
    const velT = (1 - p.hardness) * 0.5 + p.hardness * vel;
    // how far the tine swings into the pickup
    v.drive = 0.08 + 1.7 * Math.pow(velT, 1.6);
    v.out = (LEVEL * Math.pow(Math.max(vel, 1e-3), p.velCurve)) / v.drive;
    const f0 = midiToHz(v.note);
    const bellAmt = p.bell * (0.25 + 0.75 * velT);
    // the bell partials are quieter high up (shorter tines) and absent above Nyquist
    const nyq = this.sr * 0.45;
    v.g[R_TINE] = v.drive * 0.8;
    v.g[R_BAR] = v.drive * 0.2;
    v.g[R_BELL] = f0 * TINE_MODE_2 < nyq ? v.drive * bellAmt * 0.16 : 0;
    v.g[R_PING] = f0 * TINE_MODE_3 < nyq ? v.drive * bellAmt * 0.06 * velT : 0;
    // impulse: add to the current state (sine phase start)
    for (let i = 0; i < NRES; i++) v.re[i] = (v.re[i] as number) + (v.g[i] as number);
    this.updateCoefs(v);
  }

  private renderVoice(v: EpVoice, n: number): void {
    const x = this.buf;
    x.fill(0, 0, n);
    let energy = 0;
    for (let r = 0; r < NRES; r++) {
      let re = v.re[r] as number;
      let im = v.im[r] as number;
      if (re === 0 && im === 0) continue;
      const a = v.a[r] as number;
      const b = v.b[r] as number;
      for (let i = 0; i < n; i++) {
        const nr = a * re - b * im;
        im = b * re + a * im;
        re = nr;
        x[i] = (x[i] as number) + im;
      }
      const e = re * re + im * im;
      if (e < 1e-14) {
        re = 0;
        im = 0;
      }
      energy += e;
      v.re[r] = re;
      v.im[r] = im;
    }
    const bark = this.p.bark;
    const gain = v.out * v.diffNorm;
    const L = this.mixL;
    const R = this.mixR;
    let flux1 = v.flux1;
    let fade = v.fade;
    const step = v.killing ? v.fadeStep : 0;
    for (let i = 0; i < n; i++) {
      const flux = pickupCurve(x[i] as number, bark);
      let y = (flux - flux1) * gain;
      flux1 = flux;
      if (step) {
        fade = Math.max(0, fade - step);
        y *= fade;
      }
      L[i] = (L[i] as number) + y * v.gl;
      R[i] = (R[i] as number) + y * v.gr;
    }
    v.flux1 = flux1;
    v.fade = fade;
    if (v.killing && fade <= 0) {
      v.active = false;
      v.killing = false;
      if (v.pendingNote >= 0) this.startVoice(v, v.pendingId, v.pendingNote, v.pendingVel);
      return;
    }
    // energy is relative to the tine swing; ≈ −100 dB is silence
    if (energy < 1e-11 * v.drive * v.drive) {
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
    const inc = this.p.tremRate / this.sr;
    let ph = this.tremPhase;
    for (let i = 0; i < n; i++) {
      // stereo tremolo (auto-pan): the two sides swing in opposite phase
      const depth = this.tremDepth.next();
      const s = Math.sin(TWO_PI * ph);
      ph += inc;
      if (ph >= 1) ph -= 1;
      const gl = 1 - depth * 0.5 * (1 + s);
      const gr = 1 - depth * 0.5 * (1 - s);
      // preamp: gentle asymmetric saturation
      const d = this.drive.next();
      let l = (L[i] as number) * gl;
      let r = (R[i] as number) * gr;
      if (d > 1e-4) {
        // input gain grows with drive; output is compensated so level rises only gently
        const pre = 2 * (1 + 10 * d * d);
        const bias = 0.2 * d;
        const tb = fastTanh(bias);
        const norm = 1 / (Math.pow(pre, 0.75) * (1 - tb * tb));
        l += d * ((fastTanh(l * pre + bias) - tb) * norm - l);
        r += d * ((fastTanh(r * pre + bias) - tb) * norm - r);
      }
      const g = this.master.next();
      outL[offset + i] = (outL[offset + i] as number) + this.dcL.process(this.toneL.process(l)) * g;
      outR[offset + i] = (outR[offset + i] as number) + this.dcR.process(this.toneR.process(r)) * g;
    }
    this.tremPhase = ph;
  }
}
