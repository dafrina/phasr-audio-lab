/**
 * TriOsc synthesizer engine: 3 oscillators per voice → optional AM →
 * state-variable filter (with its own ADSR) → amp ADSR → stereo mix.
 *
 * Runs identically in the realtime AudioWorklet, in an OfflineAudioContext
 * worklet during export, and directly in unit tests.
 *
 * Performance notes:
 *  - All voices and their state are preallocated; render() allocates nothing.
 *  - Pitch, filter coefficients and LFO are updated at control rate
 *    (every CONTROL_BLOCK samples); oscillators and amp envelope run per sample.
 */
import {
  FILTER_ENV_OCTAVES,
  LFO_CUTOFF_OCTAVES,
  LFO_PITCH_SEMITONES,
  MAX_VOICES,
  defaultPatch,
  type OscWaveform,
  type TriOscPatch,
} from '../params';
import { Envelope, EnvelopeCoefs } from './envelope';
import { Noise, OscState, WF_NOISE, WF_PULSE, WF_SAW, WF_SINE, WF_SQUARE, WF_TRIANGLE, oscSample } from './oscillator';
import { FILTER_BP, FILTER_HP, FILTER_LP, Svf, SvfCoefs } from './svf';
import { allocateVoice } from './voiceAllocator';

export const CONTROL_BLOCK = 32;
/** Headroom for summing three oscillators and many voices */
const MIX_SCALE = 0.5;
const MONO_STACK = 32;

const WF_INDEX: Record<OscWaveform, number> = {
  sine: WF_SINE,
  triangle: WF_TRIANGLE,
  saw: WF_SAW,
  square: WF_SQUARE,
  pulse: WF_PULSE,
  noise: WF_NOISE,
};

function semisToRatio(s: number): number {
  return Math.pow(2, s / 12);
}

function lfoValue(wf: string, phase: number): number {
  switch (wf) {
    case 'triangle':
      return phase < 0.5 ? -1 + 4 * phase : 3 - 4 * phase;
    case 'square':
      return phase < 0.5 ? 1 : -1;
    case 'saw':
      return 1 - 2 * phase;
    default:
      return Math.sin(2 * Math.PI * phase);
  }
}

class Voice {
  noteId = -1;
  note = 60;
  velocity = 1;
  order = 0;
  released = false;
  sustained = false;
  /** current (gliding) pitch and target pitch, in MIDI notes */
  pitch = 60;
  target = 60;
  readonly amp = new Envelope();
  readonly filt = new Envelope();
  /** osc i: left = osc[2i], right = osc[2i+1] */
  readonly osc: OscState[] = [];
  readonly noiseL: Noise[] = [];
  readonly noiseR: Noise[] = [];
  readonly svfL = new Svf();
  readonly svfR = new Svf();
  readonly svfC = new SvfCoefs();
  readonly incL = new Float64Array(3);
  readonly incR = new Float64Array(3);
  // pending note (voice stealing waits for a short fade-out)
  hasPending = false;
  pendingId = -1;
  pendingNote = 60;
  pendingVel = 1;
  pendingFrom = -1;

  constructor(seed: number) {
    for (let i = 0; i < 6; i++) this.osc.push(new OscState());
    for (let i = 0; i < 3; i++) {
      this.noiseL.push(new Noise(seed * 7919 + i * 104729 + 1));
      this.noiseR.push(new Noise(seed * 6007 + i * 15485863 + 7));
    }
  }

  get active(): boolean {
    return this.amp.active || this.hasPending;
  }
}

export class TriOscSynth {
  readonly sampleRate: number;
  readonly voices: Voice[] = [];
  private patch: TriOscPatch = defaultPatch();
  private readonly ampC = new EnvelopeCoefs();
  private readonly filtC = new EnvelopeCoefs();
  // derived per-oscillator values
  private readonly wf = new Int32Array(3);
  private readonly enabled = new Uint8Array(3);
  private readonly pitchOffset = new Float64Array(3);
  private readonly detL = new Float64Array(3);
  private readonly detR = new Float64Array(3);
  private readonly gainTL = new Float64Array(3);
  private readonly gainTR = new Float64Array(3);
  private readonly gainL = new Float64Array(3);
  private readonly gainR = new Float64Array(3);
  private readonly stereo = new Uint8Array(3);
  private filterMode = FILTER_LP;
  private masterTarget = 0.8;
  private master = 0.8;
  private masterCoef = 0;
  private orderCounter = 0;
  private sustainPedal = false;
  private bend = 0; // -1..1
  private lfoPhase = 0;
  private lastNote = -1;
  private readonly rng = new Noise(0x5eed);
  // mono note stack
  private readonly stackIds = new Int32Array(MONO_STACK);
  private readonly stackNotes = new Float64Array(MONO_STACK);
  private readonly stackVels = new Float64Array(MONO_STACK);
  private stackLen = 0;
  private readonly slotView: { active: boolean; released: boolean; order: number }[] = [];

  constructor(sampleRate: number, patch?: TriOscPatch) {
    this.sampleRate = sampleRate;
    for (let i = 0; i < MAX_VOICES; i++) {
      this.voices.push(new Voice(i + 1));
      this.slotView.push({ active: false, released: false, order: 0 });
    }
    this.masterCoef = 1 - Math.exp(-1 / (0.01 * sampleRate));
    this.setPatch(patch ?? defaultPatch());
    this.master = this.masterTarget;
    this.gainL.set(this.gainTL);
    this.gainR.set(this.gainTR);
  }

  getPatch(): TriOscPatch {
    return this.patch;
  }

  /** Apply new parameters without disturbing playing notes. */
  setPatch(p: TriOscPatch): void {
    const prevMode = this.patch.voice.mode;
    this.patch = p;
    this.ampC.set(p.ampEnv, this.sampleRate);
    this.filtC.set(p.filterEnv, this.sampleRate);
    for (let i = 0; i < 3; i++) {
      const o = p.oscs[i];
      if (!o) continue;
      this.wf[i] = WF_INDEX[o.waveform];
      this.enabled[i] = o.enabled ? 1 : 0;
      this.pitchOffset[i] = o.coarse + o.fine / 100;
      const half = o.stereoDetune / 2 / 1200;
      this.detL[i] = Math.pow(2, -half);
      this.detR[i] = Math.pow(2, half);
      this.stereo[i] = o.stereoDetune > 0 || o.stereoPhase > 0 ? 1 : 0;
      // equal-power pan, normalized to unity at center
      const theta = ((o.pan + 1) * Math.PI) / 4;
      this.gainTL[i] = o.level * Math.cos(theta) * Math.SQRT2;
      this.gainTR[i] = o.level * Math.sin(theta) * Math.SQRT2;
    }
    this.filterMode = p.filter.type === 'highpass' ? FILTER_HP : p.filter.type === 'bandpass' ? FILTER_BP : FILTER_LP;
    this.masterTarget = p.master;
    if (prevMode !== p.voice.mode) this.allNotesOff();
  }

  // -------------------------------------------------------------------------
  // Note handling
  // -------------------------------------------------------------------------

  noteOn(id: number, note: number, velocity: number): void {
    const vel = Math.min(1, Math.max(0, velocity));
    if (this.patch.voice.mode === 'mono') {
      this.monoNoteOn(id, note, vel);
      return;
    }
    for (const v of this.voices) if (v.noteId === id && v.amp.active) return; // duplicate
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i] as Voice;
      const s = this.slotView[i] as { active: boolean; released: boolean; order: number };
      s.active = v.active;
      s.released = v.released;
      s.order = v.order;
    }
    const { index, steal } = allocateVoice(this.slotView, this.patch.voice.polyphony);
    const v = this.voices[index] as Voice;
    const glideFrom = this.patch.voice.glide > 0 && this.lastNote >= 0 ? this.lastNote : -1;
    this.lastNote = note;
    if (steal && v.amp.active) {
      // fade the stolen voice out quickly, then start the new note on it
      v.amp.kill();
      v.hasPending = true;
      v.pendingId = id;
      v.pendingNote = note;
      v.pendingVel = vel;
      v.pendingFrom = glideFrom;
      v.noteId = -2; // the old note id no longer owns this voice
      v.released = true;
      return;
    }
    this.startVoice(v, id, note, vel, glideFrom, true);
  }

  noteOff(id: number): void {
    if (this.patch.voice.mode === 'mono') {
      this.monoNoteOff(id);
      return;
    }
    for (const v of this.voices) {
      if (v.hasPending && v.pendingId === id) {
        v.hasPending = false; // note released before it could start
        continue;
      }
      if (v.noteId === id && !v.released) {
        if (this.sustainPedal) v.sustained = true;
        else this.releaseVoice(v);
      }
    }
  }

  setSustain(on: boolean): void {
    this.sustainPedal = on;
    if (on) return;
    for (const v of this.voices) {
      if (v.sustained) {
        v.sustained = false;
        if (this.patch.voice.mode === 'mono') {
          // in mono mode only release if no keys are physically held
          if (this.stackLen === 0) this.releaseVoice(v);
        } else {
          this.releaseVoice(v);
        }
      }
    }
  }

  /** value in -1..1 */
  setPitchBend(value: number): void {
    this.bend = Math.min(1, Math.max(-1, value));
  }

  /** Release every voice (normal release tails). */
  allNotesOff(): void {
    this.stackLen = 0;
    for (const v of this.voices) {
      v.hasPending = false;
      v.sustained = false;
      if (v.amp.active) this.releaseVoice(v);
    }
  }

  /** Hard stop: fade everything out within a few milliseconds. */
  panic(): void {
    this.stackLen = 0;
    this.sustainPedal = false;
    for (const v of this.voices) {
      v.hasPending = false;
      v.sustained = false;
      v.released = true;
      v.amp.kill();
      v.filt.kill();
    }
  }

  activeVoiceCount(): number {
    let n = 0;
    for (const v of this.voices) if (v.active) n++;
    return n;
  }

  private releaseVoice(v: Voice): void {
    v.released = true;
    v.sustained = false;
    v.amp.release();
    v.filt.release();
  }

  private startVoice(v: Voice, id: number, note: number, vel: number, glideFrom: number, retrigger: boolean): void {
    const wasActive = v.amp.active;
    v.noteId = id;
    v.note = note;
    v.target = note;
    v.velocity = vel;
    v.released = false;
    v.sustained = false;
    v.order = ++this.orderCounter;
    if (glideFrom >= 0) v.pitch = glideFrom;
    else if (!(wasActive && this.patch.voice.mode === 'mono' && this.patch.voice.glide > 0)) v.pitch = note;
    if (!retrigger) return;
    if (!wasActive) {
      v.svfL.reset();
      v.svfR.reset();
    }
    for (let i = 0; i < 3; i++) {
      const o = this.patch.oscs[i];
      if (!o) continue;
      const l = v.osc[2 * i] as OscState;
      const r = v.osc[2 * i + 1] as OscState;
      if (o.phaseMode === 'reset') {
        l.setPhase(o.startPhase);
        r.setPhase(o.startPhase + o.stereoPhase);
      } else if (o.phaseMode === 'random') {
        const ph = this.rng.next() * 0.5 + 0.5;
        l.setPhase(ph);
        r.setPhase(ph + o.stereoPhase);
      } else if (!wasActive) {
        r.setPhase(l.phase + o.stereoPhase);
      }
    }
    v.amp.trigger();
    v.filt.trigger();
  }

  private monoNoteOn(id: number, note: number, vel: number): void {
    // push onto the held-note stack (drop the oldest if full)
    if (this.stackLen >= MONO_STACK) {
      this.stackIds.copyWithin(0, 1);
      this.stackNotes.copyWithin(0, 1);
      this.stackVels.copyWithin(0, 1);
      this.stackLen--;
    }
    this.stackIds[this.stackLen] = id;
    this.stackNotes[this.stackLen] = note;
    this.stackVels[this.stackLen] = vel;
    this.stackLen++;
    const v = this.voices[0] as Voice;
    const held = v.amp.active && !v.released;
    const glide = this.patch.voice.glide > 0;
    if (held && this.patch.voice.legato) {
      // legato: change pitch without retriggering envelopes
      v.noteId = id;
      v.note = note;
      v.target = note;
      if (!glide) v.pitch = note;
      this.lastNote = note;
      return;
    }
    const from = glide && (v.amp.active || this.lastNote >= 0) ? (v.amp.active ? v.pitch : this.lastNote) : -1;
    this.lastNote = note;
    this.startVoice(v, id, note, vel, from, true);
  }

  private monoNoteOff(id: number): void {
    let idx = -1;
    for (let i = 0; i < this.stackLen; i++) if (this.stackIds[i] === id) idx = i;
    if (idx < 0) return;
    this.stackIds.copyWithin(idx, idx + 1, this.stackLen);
    this.stackNotes.copyWithin(idx, idx + 1, this.stackLen);
    this.stackVels.copyWithin(idx, idx + 1, this.stackLen);
    this.stackLen--;
    const v = this.voices[0] as Voice;
    if (v.noteId !== id) return; // a non-sounding held note was released
    if (this.stackLen > 0) {
      const top = this.stackLen - 1;
      const nid = this.stackIds[top] as number;
      const nnote = this.stackNotes[top] as number;
      const nvel = this.stackVels[top] as number;
      this.lastNote = nnote;
      if (this.patch.voice.legato) {
        v.noteId = nid;
        v.note = nnote;
        v.target = nnote;
        if (this.patch.voice.glide <= 0) v.pitch = nnote;
      } else {
        this.startVoice(v, nid, nnote, nvel, this.patch.voice.glide > 0 ? v.pitch : -1, true);
      }
      return;
    }
    if (this.sustainPedal) v.sustained = true;
    else this.releaseVoice(v);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /** Add `count` samples of output into L/R starting at `offset`. */
  render(outL: Float32Array, outR: Float32Array, offset: number, count: number): void {
    const p = this.patch;
    const end = offset + count;
    let pos = offset;
    while (pos < end) {
      const n = Math.min(CONTROL_BLOCK, end - pos);
      // global LFO at control rate
      const lfo = lfoValue(p.lfo.waveform, this.lfoPhase);
      this.lfoPhase += (p.lfo.rate * n) / this.sampleRate;
      this.lfoPhase -= Math.floor(this.lfoPhase);
      // smooth oscillator gains toward their targets (avoids zipper noise)
      for (let i = 0; i < 3; i++) {
        this.gainL[i] = (this.gainL[i] as number) + ((this.gainTL[i] as number) - (this.gainL[i] as number)) * 0.25;
        this.gainR[i] = (this.gainR[i] as number) + ((this.gainTR[i] as number) - (this.gainR[i] as number)) * 0.25;
      }
      for (const v of this.voices) {
        if (!v.amp.active) {
          if (v.hasPending) this.startPending(v);
          else continue;
        }
        this.renderVoice(v, outL, outR, pos, n, lfo);
        if (!v.amp.active) {
          v.filt.reset();
          if (v.hasPending) this.startPending(v);
          else v.noteId = -1;
        }
      }
      pos += n;
    }
    // master level with per-sample smoothing
    let m = this.master;
    const mt = this.masterTarget;
    const mc = this.masterCoef;
    for (let i = offset; i < end; i++) {
      m += (mt - m) * mc;
      outL[i] = (outL[i] as number) * m;
      outR[i] = (outR[i] as number) * m;
    }
    this.master = m;
  }

  private startPending(v: Voice): void {
    v.hasPending = false;
    v.amp.reset();
    v.filt.reset();
    this.startVoice(v, v.pendingId, v.pendingNote, v.pendingVel, v.pendingFrom, true);
  }

  private renderVoice(v: Voice, outL: Float32Array, outR: Float32Array, pos: number, n: number, lfo: number): void {
    const p = this.patch;
    const sr = this.sampleRate;
    const hq = p.quality === 'hq';

    // --- control rate: glide, pitch, filter ---
    if (p.voice.glide > 0 && v.pitch !== v.target) {
      // exponential glide; time constant is a third of the glide time
      const coef = 1 - Math.exp(-n / (p.voice.glide * sr * 0.333));
      v.pitch += (v.target - v.pitch) * coef;
      if (Math.abs(v.target - v.pitch) < 0.001) v.pitch = v.target;
    } else {
      v.pitch = v.target;
    }
    let pitch = v.pitch + this.bend * p.voice.bendRange;
    if (p.lfo.target === 'pitch') pitch += lfo * p.lfo.depth * p.lfo.depth * LFO_PITCH_SEMITONES;
    for (let i = 0; i < 3; i++) {
      const f = 440 * semisToRatio(pitch + (this.pitchOffset[i] as number) - 69);
      v.incL[i] = Math.min(0.49, (f * (this.detL[i] as number)) / sr);
      v.incR[i] = Math.min(0.49, (f * (this.detR[i] as number)) / sr);
    }
    const filterOn = p.filter.enabled;
    if (filterOn) {
      const fe = v.filt.advance(this.filtC, n);
      let oct = p.filter.envAmount * FILTER_ENV_OCTAVES * fe + (p.filter.keyTrack * (v.note - 60)) / 12;
      if (p.lfo.target === 'cutoff') oct += lfo * p.lfo.depth * LFO_CUTOFF_OCTAVES;
      v.svfC.set(p.filter.cutoff * Math.pow(2, oct), p.filter.resonance, sr);
    }
    const ampMod = p.lfo.target === 'amp' ? 1 - p.lfo.depth * (0.5 - 0.5 * lfo) : 1;
    const vs = p.voice.velocitySens;
    const gain = ((1 - vs) + vs * v.velocity) * ampMod * MIX_SCALE;

    const am = p.amMode;
    const en0 = this.enabled[0] === 1;
    const en1 = this.enabled[1] === 1;
    const en2 = this.enabled[2] === 1;
    const lvl3 = p.oscs[2].level;
    const pw0 = p.oscs[0].pulseWidth;
    const pw1 = p.oscs[1].pulseWidth;
    const pw2 = p.oscs[2].pulseWidth;
    const ampC = this.ampC;
    const mode = this.filterMode;

    for (let k = 0; k < n; k++) {
      const env = v.amp.next(ampC);
      let l = 0;
      let r = 0;
      if (en0) {
        const [a, b] = this.oscPair(v, 0, hq, pw0);
        l += a * (this.gainL[0] as number);
        r += b * (this.gainR[0] as number);
      }
      if (en1) {
        const [a, b] = this.oscPair(v, 1, hq, pw1);
        l += a * (this.gainL[1] as number);
        r += b * (this.gainR[1] as number);
      }
      if (en2) {
        const [a, b] = this.oscPair(v, 2, hq, pw2);
        if (am) {
          // osc 3 as amplitude modulator for osc 1+2: depth = osc 3 level
          l *= 1 - lvl3 + lvl3 * (0.5 + 0.5 * a);
          r *= 1 - lvl3 + lvl3 * (0.5 + 0.5 * b);
        } else {
          l += a * (this.gainL[2] as number);
          r += b * (this.gainR[2] as number);
        }
      }
      if (filterOn) {
        l = v.svfL.process(l, v.svfC, mode);
        r = v.svfR.process(r, v.svfC, mode);
      }
      const g = env * gain;
      outL[pos + k] = (outL[pos + k] as number) + l * g;
      outR[pos + k] = (outR[pos + k] as number) + r * g;
      if (!v.amp.active) break;
    }
  }

  // reused tuple for oscPair results (avoids allocating per sample)
  private readonly pair: [number, number] = [0, 0];

  private oscPair(v: Voice, i: number, hq: boolean, pw: number): [number, number] {
    const wf = this.wf[i] as number;
    const out = this.pair;
    if (wf === WF_NOISE) {
      const a = (v.noiseL[i] as Noise).next();
      out[0] = a;
      out[1] = this.stereo[i] === 1 ? (v.noiseR[i] as Noise).next() : a;
      return out;
    }
    const sl = v.osc[2 * i] as OscState;
    const sr = v.osc[2 * i + 1] as OscState;
    if (this.stereo[i] === 1) {
      out[0] = oscSample(sl, wf, v.incL[i] as number, hq, pw);
      out[1] = oscSample(sr, wf, v.incR[i] as number, hq, pw);
    } else {
      const a = oscSample(sl, wf, v.incL[i] as number, hq, pw);
      // keep the right state in step so enabling stereo later is seamless
      sr.phase = sl.phase;
      sr.tri = sl.tri;
      out[0] = a;
      out[1] = a;
    }
    return out;
  }
}
