/**
 * Keyforge analog engine — pads and techno sounds.
 *
 * Per voice: up to 7 detuned, stereo-spread band-limited saws (free-running
 * random phases like analog oscillators), a square sub one octave down and
 * noise, a pre-filter drive stage, a 4-pole resonant low-pass (two cascaded
 * TPT state-variable stages) with its own ADSR, key tracking and velocity,
 * and an amp ADSR. Mono mode adds legato with glide for acid lines. A
 * stereo BBD-style ensemble (three modulated taps per side) widens pads.
 */
import {
  BEND_SEMITONES,
  DelayLine,
  HeldIds,
  MAX_BLOCK,
  Smoother,
  TWO_PI,
  clamp,
  fastTanh,
  hash01,
  midiToHz,
  panGains,
  type KeysEngine,
} from './common';
import { Envelope, EnvelopeCoefs } from '../../synth/dsp/envelope';
import { Noise, OscState, WF_SAW, WF_SQUARE, renderOscBlock } from '../../synth/dsp/oscillator';
import { FILTER_LP, Svf, SvfCoefs, svfBlock } from '../../synth/dsp/svf';
import { allocateVoice } from '../../synth/dsp/voiceAllocator';

const POLYPHONY = 16;
const MAX_UNISON = 7;
const CONTROL = 16;
const LEVEL = 0.22;
export const ENV_OCTAVES = 6;

export interface AnalogParams {
  unison: number;
  detune: number;
  spread: number;
  sub: number;
  noise: number;
  cutoff: number;
  reso: number;
  envAmt: number;
  keyTrack: number;
  velFilter: number;
  fAttack: number;
  fDecay: number;
  fSustain: number;
  fRelease: number;
  attack: number;
  decay: number;
  sustainLvl: number;
  release: number;
  drive: number;
  ensemble: number;
  mono: number;
  glide: number;
  master: number;
}

/** cutoff (Hz) for a voice state */
export function analogCutoff(p: AnalogParams, note: number, vel: number, fenv: number, sampleRate: number): number {
  const oct = p.envAmt * ENV_OCTAVES * fenv + (p.keyTrack * (note - 60)) / 12 + p.velFilter * 2.5 * (vel - 0.6);
  return clamp(p.cutoff * Math.pow(2, oct), 20, sampleRate * 0.45);
}

class AnalogVoice {
  active = false;
  note = 60;
  order = 0;
  vel = 0;
  readonly held = new HeldIds();
  sustained = false;
  released = false;
  /** current and target pitch in semitones (glide) */
  pitch = 60;
  target = 60;
  readonly oscs: OscState[] = [];
  readonly sub = new OscState();
  readonly amp = new Envelope();
  readonly fenv = new Envelope();
  readonly f1L = new Svf();
  readonly f2L = new Svf();
  readonly f1R = new Svf();
  readonly f2R = new Svf();
  pendingNote = -1;
  pendingVel = 0;
  pendingId = 0;

  constructor() {
    for (let i = 0; i < MAX_UNISON; i++) this.oscs.push(new OscState());
  }
}

export class AnalogEngine implements KeysEngine {
  private readonly sr: number;
  private p: AnalogParams;
  private readonly voices: AnalogVoice[] = [];
  private orderCounter = 0;
  private pedal = false;
  private bend = 0;
  private readonly ampC = new EnvelopeCoefs();
  private readonly filtC = new EnvelopeCoefs();
  private readonly c1 = new SvfCoefs();
  private readonly c2 = new SvfCoefs();
  private readonly osc = new Float64Array(MAX_BLOCK);
  private readonly bL = new Float64Array(CONTROL);
  private readonly bR = new Float64Array(CONTROL);
  private readonly mixL = new Float64Array(MAX_BLOCK);
  private readonly mixR = new Float64Array(MAX_BLOCK);
  private readonly ratio = new Float64Array(MAX_UNISON);
  private readonly gL = new Float64Array(MAX_UNISON);
  private readonly gR = new Float64Array(MAX_UNISON);
  private unison = 1;
  private readonly noise = new Noise(0xa11a);
  private readonly pan = { l: 0, r: 0 };
  /** mono mode note stack */
  private readonly stack: { id: number; note: number; vel: number }[] = [];
  // ensemble
  private readonly ensL: DelayLine;
  private readonly ensR: DelayLine;
  private ensPhase = 0;
  private ensPhaseFast = 0;
  private readonly ens = new Smoother(0);
  private readonly master = new Smoother(0.8);

  constructor(sampleRate: number, params: AnalogParams) {
    this.sr = sampleRate;
    this.p = params;
    for (let i = 0; i < POLYPHONY; i++) this.voices.push(new AnalogVoice());
    this.ensL = new DelayLine(Math.ceil(0.02 * sampleRate));
    this.ensR = new DelayLine(Math.ceil(0.02 * sampleRate));
    this.ens.setTime(0.05, sampleRate);
    this.master.setTime(0.02, sampleRate);
    this.setParams(params as unknown as Record<string, number>);
    this.ens.value = this.ens.target;
    this.master.value = this.master.target;
  }

  private get isMono(): boolean {
    return this.p.mono >= 0.5;
  }

  setParams(raw: Record<string, number>): void {
    const wasMono = this.isMono;
    const p = raw as unknown as AnalogParams;
    this.p = p;
    this.ampC.set({ attack: p.attack, decay: p.decay, sustain: p.sustainLvl, release: p.release }, this.sr);
    this.filtC.set({ attack: p.fAttack, decay: p.fDecay, sustain: p.fSustain, release: p.fRelease }, this.sr);
    const u = clamp(Math.round(p.unison), 1, MAX_UNISON);
    this.unison = u;
    const norm = 1 / Math.sqrt(u);
    for (let i = 0; i < u; i++) {
      // symmetric spread, slightly denser in the middle like classic supersaws
      const d = u === 1 ? 0 : (2 * i) / (u - 1) - 1;
      const shaped = Math.sign(d) * Math.pow(Math.abs(d), 1.3);
      this.ratio[i] = Math.pow(2, (p.detune * shaped) / 1200);
      panGains(p.spread * d * (i % 2 ? -1 : 1), this.pan);
      this.gL[i] = this.pan.l * norm * Math.SQRT2;
      this.gR[i] = this.pan.r * norm * Math.SQRT2;
    }
    this.ens.target = p.ensemble;
    this.master.target = p.master;
    if (wasMono !== this.isMono) this.allNotesOff();
  }

  setBend(value: number): void {
    this.bend = clamp(value, -1, 1) * BEND_SEMITONES;
  }

  setSustain(on: boolean): void {
    this.pedal = on;
    if (on) return;
    for (const v of this.voices) {
      if (v.active && v.sustained) {
        v.sustained = false;
        v.released = true;
        v.amp.release();
        v.fenv.release();
      }
    }
  }

  noteOn(id: number, note: number, velocity: number): void {
    const vel = clamp(velocity, 0, 1);
    if (this.isMono) {
      const v = this.voices[0] as AnalogVoice;
      const legato = this.stack.length > 0 && v.active;
      this.stack.push({ id, note, vel });
      v.held.add(id);
      v.sustained = false;
      v.released = false;
      v.target = note;
      v.note = note;
      if (legato) {
        // slide: no retrigger; glide only on legato notes (classic acid behaviour)
        if (this.p.glide <= 0.0005) v.pitch = note;
        return;
      }
      v.pitch = note;
      this.trigger(v, note, vel, !v.active);
      return;
    }
    const { index, steal } = allocateVoice(this.voices, POLYPHONY);
    const v = this.voices[index] as AnalogVoice;
    if (steal && v.active) {
      v.amp.kill();
      v.fenv.kill();
      v.pendingNote = note;
      v.pendingVel = vel;
      v.pendingId = id;
      v.held.clear();
      v.order = ++this.orderCounter;
      v.released = false;
      return;
    }
    v.held.clear();
    v.held.add(id);
    v.pitch = note;
    v.target = note;
    this.trigger(v, note, vel, true);
  }

  private trigger(v: AnalogVoice, note: number, vel: number, fresh: boolean): void {
    v.active = true;
    v.note = note;
    v.vel = vel;
    v.sustained = false;
    v.released = false;
    v.order = ++this.orderCounter;
    if (fresh) {
      // analog oscillators are free running: random start phases
      for (let i = 0; i < MAX_UNISON; i++) (v.oscs[i] as OscState).setPhase(hash01(v.order, i));
      v.sub.setPhase(0);
      v.f1L.reset();
      v.f2L.reset();
      v.f1R.reset();
      v.f2R.reset();
    }
    v.amp.trigger();
    v.fenv.trigger();
  }

  noteOff(id: number): void {
    if (this.isMono) {
      const i = this.stack.findIndex((s) => s.id === id);
      if (i < 0) return;
      const wasTop = i === this.stack.length - 1;
      this.stack.splice(i, 1);
      const v = this.voices[0] as AnalogVoice;
      v.held.remove(id);
      const top = this.stack[this.stack.length - 1];
      if (top) {
        if (wasTop) {
          v.target = top.note;
          v.note = top.note;
          if (this.p.glide <= 0.0005) v.pitch = top.note;
        }
        return;
      }
      this.releaseVoice(v);
      return;
    }
    for (const v of this.voices) {
      if (!v.active || !v.held.remove(id) || !v.held.empty) continue;
      this.releaseVoice(v);
    }
  }

  private releaseVoice(v: AnalogVoice): void {
    v.released = true;
    if (this.pedal) {
      v.sustained = true;
      return;
    }
    v.amp.release();
    v.fenv.release();
  }

  allNotesOff(): void {
    this.stack.length = 0;
    for (const v of this.voices) {
      if (!v.active) continue;
      v.held.clear();
      v.pendingNote = -1;
      v.sustained = false;
      v.released = true;
      v.amp.release();
      v.fenv.release();
    }
  }

  panic(): void {
    this.stack.length = 0;
    this.pedal = false;
    for (const v of this.voices) {
      v.active = false;
      v.pendingNote = -1;
      v.held.clear();
      v.amp.reset();
      v.fenv.reset();
    }
    this.ensL.clear();
    this.ensR.clear();
  }

  activeVoices(): number {
    let n = 0;
    for (const v of this.voices) if (v.active) n++;
    return n;
  }

  private renderVoice(v: AnalogVoice, count: number): void {
    const p = this.p;
    const sr = this.sr;
    const u = this.unison;
    const glideCoef = p.glide > 0.0005 ? Math.exp(-CONTROL / (p.glide * 0.4 * sr)) : 0;
    const driveGain = 1 + 5 * p.drive * p.drive;
    const driveNorm = 1 / Math.pow(driveGain, 0.7);
    const subLevel = p.sub * 0.8;
    const noiseLevel = p.noise * 0.5;
    const ampVel = (0.35 + 0.65 * v.vel) * LEVEL;
    const L = this.mixL;
    const R = this.mixR;
    const osc = this.osc;
    const bL = this.bL;
    const bR = this.bR;
    let pos = 0;
    while (pos < count) {
      const n = Math.min(CONTROL, count - pos);
      v.pitch = v.target + (v.pitch - v.target) * glideCoef;
      const freq = midiToHz(v.pitch + this.bend);
      bL.fill(0, 0, n);
      bR.fill(0, 0, n);
      for (let i = 0; i < u; i++) {
        renderOscBlock(v.oscs[i] as OscState, WF_SAW, Math.min(0.45, (freq * (this.ratio[i] as number)) / sr), true, 0.5, osc, n);
        const gl = this.gL[i] as number;
        const gr = this.gR[i] as number;
        for (let j = 0; j < n; j++) {
          const x = osc[j] as number;
          bL[j] = (bL[j] as number) + x * gl;
          bR[j] = (bR[j] as number) + x * gr;
        }
      }
      if (subLevel > 0) {
        renderOscBlock(v.sub, WF_SQUARE, Math.min(0.45, (freq * 0.5) / sr), true, 0.5, osc, n);
        for (let j = 0; j < n; j++) {
          const x = (osc[j] as number) * subLevel;
          bL[j] = (bL[j] as number) + x;
          bR[j] = (bR[j] as number) + x;
        }
      }
      if (noiseLevel > 0) {
        for (let j = 0; j < n; j++) {
          bL[j] = (bL[j] as number) + this.noise.next() * noiseLevel;
          bR[j] = (bR[j] as number) + this.noise.next() * noiseLevel;
        }
      }
      if (p.drive > 0.001) {
        for (let j = 0; j < n; j++) {
          bL[j] = fastTanh((bL[j] as number) * driveGain) * driveNorm * 1.4;
          bR[j] = fastTanh((bR[j] as number) * driveGain) * driveNorm * 1.4;
        }
      }
      const fe = v.fenv.advance(this.filtC, n);
      const fc = analogCutoff(p, v.note, v.vel, fe, sr);
      this.c1.set(fc, 0.1, sr);
      this.c2.set(fc, p.reso, sr);
      svfBlock(v.f1L, this.c1, FILTER_LP, bL, n);
      svfBlock(v.f2L, this.c2, FILTER_LP, bL, n);
      svfBlock(v.f1R, this.c1, FILTER_LP, bR, n);
      svfBlock(v.f2R, this.c2, FILTER_LP, bR, n);
      for (let j = 0; j < n; j++) {
        const a = v.amp.next(this.ampC) * ampVel;
        L[pos + j] = (L[pos + j] as number) + (bL[j] as number) * a;
        R[pos + j] = (R[pos + j] as number) + (bR[j] as number) * a;
      }
      pos += n;
      if (!v.amp.active) break;
    }
    if (!v.amp.active) {
      v.active = false;
      if (v.pendingNote >= 0) {
        const note = v.pendingNote;
        v.pendingNote = -1;
        v.held.add(v.pendingId);
        v.pitch = note;
        v.target = note;
        this.trigger(v, note, v.pendingVel, true);
      } else v.held.clear();
    }
  }

  render(outL: Float32Array, outR: Float32Array, offset: number, count: number): void {
    const L = this.mixL;
    const R = this.mixR;
    L.fill(0, 0, count);
    R.fill(0, 0, count);
    for (const v of this.voices) if (v.active) this.renderVoice(v, count);
    const sr = this.sr;
    const slow = 0.55 / sr;
    const fast = 5.8 / sr;
    const base = 0.007 * sr;
    const depth = 0.0018 * sr;
    const vib = 0.00012 * sr;
    for (let i = 0; i < count; i++) {
      let l = L[i] as number;
      let r = R[i] as number;
      const e = this.ens.next();
      this.ensL.write(l);
      this.ensR.write(r);
      if (e > 1e-4) {
        let wl = 0;
        let wr = 0;
        for (let t = 0; t < 3; t++) {
          const ph = TWO_PI * (this.ensPhase + t / 3);
          const fph = TWO_PI * (this.ensPhaseFast + t / 3);
          const m = Math.sin(ph) * depth + Math.sin(fph) * vib;
          wl += this.ensL.readCubic(base + m);
          wr += this.ensR.readCubic(base - m);
        }
        l = l * (1 - 0.45 * e) + wl * 0.33 * e * 0.9;
        r = r * (1 - 0.45 * e) + wr * 0.33 * e * 0.9;
      }
      this.ensPhase += slow;
      if (this.ensPhase >= 1) this.ensPhase -= 1;
      this.ensPhaseFast += fast;
      if (this.ensPhaseFast >= 1) this.ensPhaseFast -= 1;
      const g = this.master.next();
      outL[offset + i] = (outL[offset + i] as number) + l * g;
      outR[offset + i] = (outR[offset + i] as number) + r * g;
    }
  }
}
