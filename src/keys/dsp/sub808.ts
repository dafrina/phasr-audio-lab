/**
 * 808 — the classic sub bass: a sine whose pitch drops from a short "knock"
 * to the note, with a click on the attack, a long exponential decay,
 * saturation for harmonics you can hear on small speakers, and true 808
 * glide: a note played while another is still held slides there instead of
 * restarting (or every note slides, in "Always" mode). Monophonic, last note
 * wins, releasing returns to a key that is still held.
 */
import { Noise } from '../../synth/dsp/oscillator';
import { BEND_SEMITONES, DcBlocker, HeldIds, MAX_BLOCK, Smoother, TWO_PI, clamp, type KeysEngine } from './common';

export interface Sub808Params {
  /** semitones the pitch starts above the note */
  pitchAmt: number;
  /** seconds for the pitch knock to fall back */
  pitchDecay: number;
  click: number;
  punch: number;
  /** seconds (to −60 dB) while the key is held */
  decay: number;
  /** seconds (to −60 dB) after the key is released */
  release: number;
  /** seconds for a slide */
  glide: number;
  /** 0 = slide only between overlapping notes (legato), 1 = every note slides */
  glideMode: number;
  drive: number;
  /** Hz: low-pass after the drive */
  tone: number;
  master: number;
}

const LN_1000 = Math.log(1000);
const LEVEL = 0.55;

export class Sub808Engine implements KeysEngine {
  private readonly sr: number;
  private p: Sub808Params;
  private readonly stack: { id: number; note: number; vel: number }[] = [];
  private readonly sustained = new HeldIds();
  private pedal = false;
  private bend = 0;
  // voice state
  private active = false;
  private released = false;
  private phase = 0;
  /** current pitch (MIDI, gliding) and where it heads */
  private pitch = 36;
  private target = 36;
  private vel = 0.8;
  private env = 0;
  /** short attack ramp (no click from a jump) */
  private atk = 1;
  private pitchEnv = 0;
  private punchEnv = 0;
  private clickEnv = 0;
  private clickLp = 0;
  private toneLp = 0;
  private readonly dc = new DcBlocker();
  private readonly noise = new Noise(0x808);
  private readonly master = new Smoother(0.8);
  private readonly out = new Float64Array(MAX_BLOCK);

  constructor(sampleRate: number, params: Sub808Params) {
    this.sr = sampleRate;
    this.p = params;
    this.master.setTime(0.02, sampleRate);
    this.master.value = this.master.target = params.master;
  }

  setParams(p: Record<string, number>): void {
    this.p = p as unknown as Sub808Params;
    this.master.target = this.p.master;
  }

  setBend(value: number): void {
    this.bend = clamp(value, -1, 1) * BEND_SEMITONES;
  }

  setSustain(on: boolean): void {
    this.pedal = on;
    if (!on) {
      this.sustained.clear();
      if (!this.stack.length && this.active) this.released = true;
    }
  }

  noteOn(id: number, note: number, velocity: number): void {
    const legato = this.active && !this.released && this.stack.length > 0;
    this.stack.push({ id, note, vel: velocity });
    this.target = note;
    const slide = this.p.glide > 0.0005 && (this.p.glideMode >= 0.5 ? this.active && this.env > 1e-3 : legato);
    if (legato && slide) {
      // 808 slide: keep the note ringing, only move the pitch
      this.released = false;
      return;
    }
    if (!slide) this.pitch = note;
    this.vel = velocity;
    this.released = false;
    this.active = true;
    // full level again, ramped from where the ringing note is now (a re-hit doesn't click)
    const now = this.active ? this.env * this.atk : 0;
    this.env = 1;
    this.atk = Math.min(1, now);
    this.pitchEnv = this.p.pitchAmt;
    this.punchEnv = 1;
    this.clickEnv = 1;
    // from silence: start the sine at zero crossing
    if (now < 1e-3) this.phase = 0;
  }

  noteOff(id: number): void {
    const i = this.stack.findIndex((s) => s.id === id);
    if (i < 0) return;
    const wasTop = i === this.stack.length - 1;
    this.stack.splice(i, 1);
    if (this.pedal) {
      this.sustained.add(id);
      return;
    }
    if (!wasTop) return;
    const back = this.stack[this.stack.length - 1];
    if (back) {
      // still holding an earlier key: slide (or jump) back to it
      this.target = back.note;
      if (this.p.glide <= 0.0005) this.pitch = back.note;
      return;
    }
    this.released = true;
  }

  allNotesOff(): void {
    this.stack.length = 0;
    this.sustained.clear();
    if (this.active) this.released = true;
  }

  panic(): void {
    this.allNotesOff();
    this.active = false;
    this.env = 0;
  }

  activeVoices(): number {
    return this.active ? 1 : 0;
  }

  render(outL: Float32Array, outR: Float32Array, offset: number, count: number): void {
    if (!this.active) return;
    const p = this.p;
    const sr = this.sr;
    const hold = Math.exp(-LN_1000 / (Math.max(0.02, p.decay) * sr));
    const rel = Math.exp(-LN_1000 / (Math.max(0.005, p.release) * sr));
    const glideC = p.glide > 0.0005 ? 1 - Math.exp(-1 / (p.glide * 0.35 * sr)) : 1;
    const pitchC = Math.exp(-1 / (Math.max(0.002, p.pitchDecay) * 0.35 * sr));
    const punchC = Math.exp(-1 / (0.035 * sr));
    const clickC = Math.exp(-1 / (0.0025 * sr));
    const atkStep = 1 / (0.0015 * sr);
    const drive = 1 + p.drive * p.drive * 14;
    const driveNorm = 1 / Math.tanh(drive);
    const toneA = 1 - Math.exp((-TWO_PI * clamp(p.tone, 40, 18000)) / sr);
    const o = this.out;
    for (let i = 0; i < count; i++) {
      this.pitch += (this.target - this.pitch) * glideC;
      const semis = this.pitch + this.pitchEnv + this.bend;
      this.pitchEnv *= pitchC;
      this.phase += (440 * Math.pow(2, (semis - 69) / 12)) / sr;
      if (this.phase >= 1) this.phase -= 1;
      this.env *= this.released ? rel : hold;
      if (this.atk < 1) this.atk = Math.min(1, this.atk + atkStep);
      this.punchEnv *= punchC;
      const amp = this.env * this.atk * (1 + p.punch * 1.2 * this.punchEnv) * (0.3 + 0.7 * this.vel);
      let x = Math.sin(TWO_PI * this.phase) * amp;
      // click: a few ms of band-limited noise on the attack
      if (this.clickEnv > 1e-4) {
        const n = this.noise.next();
        this.clickLp += (n - this.clickLp) * 0.35;
        x += (n - this.clickLp) * this.clickEnv * p.click * 0.5 * this.vel;
        this.clickEnv *= clickC;
      }
      // saturation (harmonics that small speakers can play), then tone
      x = Math.tanh(x * drive) * driveNorm;
      this.toneLp += (x - this.toneLp) * toneA;
      o[i] = this.dc.process(this.toneLp);
    }
    for (let i = 0; i < count; i++) {
      const g = this.master.next() * LEVEL;
      const v = (o[i] as number) * g;
      outL[offset + i] = (outL[offset + i] as number) + v;
      outR[offset + i] = (outR[offset + i] as number) + v;
    }
    if (this.released && this.env < 1e-5) {
      this.active = false;
      this.env = 0;
    }
  }
}
