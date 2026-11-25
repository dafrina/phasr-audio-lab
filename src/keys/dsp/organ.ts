/**
 * Keyforge tonewheel organ.
 *
 *  - 91 free-running tonewheels (C1 … F#7, equal tempered). Keys don't start
 *    oscillators, they close contacts: two keys that share a wheel are phase
 *    locked, exactly like the real instrument.
 *  - Nine drawbars per key at the classic footages (16′ … 1′), each step
 *    ≈ 3 dB. Wheels beyond the top of the generator fold back an octave, and
 *    the 16′ folds up in the lowest octave.
 *  - Key click: the nine busbar contacts of a key close a few milliseconds
 *    apart with an abrupt step, plus a short noise burst.
 *  - Percussion: single-triggered (only after all keys were released),
 *    2nd or 3rd harmonic, exponential decay.
 *  - Chorus/vibrato scanner, tube-style overdrive, and a rotary speaker:
 *    800 Hz crossover, horn and drum rotors with realistic spin-up/down
 *    inertia, Doppler shift, directional amplitude modulation and a cabinet
 *    reflection, picked up by two virtual microphones.
 */
import {
  BEND_SEMITONES,
  DcBlocker,
  DelayLine,
  HeldIds,
  MAX_BLOCK,
  OnePole,
  Smoother,
  TWO_PI,
  ToneFilter,
  clamp,
  fastTanh,
  hash01,
  midiToHz,
  type KeysEngine,
} from './common';
import { Noise } from '../../synth/dsp/oscillator';

/** semitone offsets of the drawbars relative to the key (16′ 5⅓′ 8′ 4′ 2⅔′ 2′ 1⅗′ 1⅓′ 1′) */
export const DRAWBAR_SEMITONES = [-12, 7, 0, 12, 19, 24, 28, 31, 36] as const;
export const WHEEL_LOW = 24;
export const WHEEL_HIGH = 114;
const MAX_KEYS = 61;
const WHEEL_LEVEL = 0.055;

/** drawbar position 0..8 → linear gain (8 = 0 dB, −3 dB per step, linear fade below 1) */
export function drawbarGain(level: number): number {
  if (level <= 0) return 0;
  if (level >= 1) return Math.pow(10, (-(8 - level) * 3) / 20);
  return level * Math.pow(10, (-7 * 3) / 20);
}

/** the tonewheel (MIDI number) a drawbar of a key sounds */
export function wheelFor(note: number, drawbar: number): number {
  let w = note + (DRAWBAR_SEMITONES[drawbar] ?? 0);
  while (w < WHEEL_LOW) w += 12;
  while (w > WHEEL_HIGH) w -= 12;
  return w;
}

export interface OrganParams {
  db0: number;
  db1: number;
  db2: number;
  db3: number;
  db4: number;
  db5: number;
  db6: number;
  db7: number;
  db8: number;
  click: number;
  perc: number;
  percHarm: number;
  percDecay: number;
  percLevel: number;
  drive: number;
  rotor: number;
  rotorMix: number;
  vibrato: number;
  master: number;
}

class OrganKey {
  active = false;
  note = 60;
  down = false;
  readonly held = new HeldIds();
  readonly value = new Float64Array(9);
  readonly wait = new Int32Array(9);
  target = 0;
  rate = 1;
  settled = false;
}

interface Rotor {
  phase: number;
  rate: number;
  slow: number;
  fast: number;
  upTime: number;
  downTime: number;
}

export class OrganEngine implements KeysEngine {
  private readonly sr: number;
  private p: OrganParams;
  private readonly keys: OrganKey[] = [];
  private readonly wheelPhase = new Float64Array(128);
  private readonly wheelInc = new Float64Array(128);
  /** per-wheel per-sample gain for this block */
  private readonly wheelBuf: Float64Array[] = [];
  private readonly wheelConst = new Float64Array(128);
  private readonly wheelUsed = new Uint8Array(128);
  private readonly wheelDyn = new Uint8Array(128);
  private readonly usedList = new Int32Array(128);
  private usedCount = 0;
  private readonly dbGain = new Float64Array(9);
  private readonly mix = new Float64Array(MAX_BLOCK);
  private readonly percBuf = new Float64Array(MAX_BLOCK);
  private percEnv = 0;
  private percCoef = 0;
  private bendRatio = 1;
  private readonly noise = new Noise(0x0c1c);
  private clickEnv = 0;
  private readonly clickDecay: number;
  private readonly clickLp = new OnePole();
  // chorus scanner
  private readonly scanner: DelayLine;
  private scanPhase = 0;
  private readonly vib = new Smoother(0);
  // preamp
  private readonly drive = new Smoother(0);
  private readonly preLp = new ToneFilter();
  // rotary
  private readonly xover = new ToneFilter();
  private readonly hornLp = new ToneFilter();
  private readonly hornLine: DelayLine;
  private readonly drumLine: DelayLine;
  private readonly horn: Rotor = { phase: 0, rate: 0.8, slow: 0.8, fast: 6.75, upTime: 0.7, downTime: 0.9 };
  private readonly drum: Rotor = { phase: 0.25, rate: 0.67, slow: 0.67, fast: 5.9, upTime: 3.5, downTime: 4.5 };
  private readonly rotorMix = new Smoother(0.8);
  private readonly dcL = new DcBlocker();
  private readonly dcR = new DcBlocker();
  private readonly master = new Smoother(0.8);

  constructor(sampleRate: number, params: OrganParams) {
    this.sr = sampleRate;
    this.p = params;
    for (let i = 0; i < MAX_KEYS; i++) this.keys.push(new OrganKey());
    for (let w = 0; w < 128; w++) {
      this.wheelBuf.push(new Float64Array(MAX_BLOCK));
      // free-running wheels start at scattered phases
      this.wheelPhase[w] = hash01(w, 7);
    }
    this.clickDecay = Math.exp(-1 / (0.0025 * sampleRate));
    this.clickLp.setCutoff(2500, sampleRate);
    this.scanner = new DelayLine(Math.ceil(0.004 * sampleRate));
    this.hornLine = new DelayLine(Math.ceil(0.006 * sampleRate));
    this.drumLine = new DelayLine(Math.ceil(0.006 * sampleRate));
    this.xover.set(800, sampleRate, 0.5);
    this.hornLp.set(7000, sampleRate, 0.7);
    this.preLp.set(9000, sampleRate, 0.7);
    this.dcL.setCutoff(10, sampleRate);
    this.dcR.setCutoff(10, sampleRate);
    this.vib.setTime(0.05, sampleRate);
    this.drive.setTime(0.03, sampleRate);
    this.rotorMix.setTime(0.05, sampleRate);
    this.master.setTime(0.02, sampleRate);
    this.setParams(params as unknown as Record<string, number>);
    this.vib.value = this.vib.target;
    this.drive.value = this.drive.target;
    this.rotorMix.value = this.rotorMix.target;
    this.master.value = this.master.target;
    const fast = params.rotor >= 0.5;
    this.horn.rate = fast ? this.horn.fast : this.horn.slow;
    this.drum.rate = fast ? this.drum.fast : this.drum.slow;
    this.updateWheelIncs();
  }

  setParams(raw: Record<string, number>): void {
    const p = raw as unknown as OrganParams;
    this.p = p;
    const dbs = [p.db0, p.db1, p.db2, p.db3, p.db4, p.db5, p.db6, p.db7, p.db8];
    for (let d = 0; d < 9; d++) this.dbGain[d] = drawbarGain(dbs[d] ?? 0) * WHEEL_LEVEL;
    this.percCoef = Math.exp(-6.91 / Math.max(1, p.percDecay * this.sr));
    this.vib.target = p.vibrato;
    this.drive.target = p.drive;
    this.rotorMix.target = p.rotorMix;
    this.master.target = p.master;
  }

  private updateWheelIncs(): void {
    for (let w = 0; w < 128; w++) this.wheelInc[w] = (midiToHz(w) * this.bendRatio) / this.sr;
  }

  setBend(value: number): void {
    const r = Math.pow(2, (clamp(value, -1, 1) * BEND_SEMITONES) / 12);
    if (r === this.bendRatio) return;
    this.bendRatio = r;
    this.updateWheelIncs();
  }

  /** organs have no sustain pedal; the pedal holds keys like a latch */
  private pedal = false;

  setSustain(on: boolean): void {
    this.pedal = on;
    if (!on) for (const k of this.keys) if (k.active && k.down && k.held.empty) this.release(k);
  }

  private anyKeyDown(): boolean {
    for (const k of this.keys) if (k.active && k.down) return true;
    return false;
  }

  noteOn(id: number, note: number): void {
    let key: OrganKey | undefined;
    for (const k of this.keys) if (k.active && k.note === note) key = k;
    if (!key) key = this.keys.find((k) => !k.active);
    if (!key) return;
    // percussion is single-triggered: only when no other key is down
    if (!this.anyKeyDown() && this.p.perc >= 0.5) this.percEnv = 1;
    const wasDown = key.active && key.down;
    key.held.add(id);
    if (wasDown) return;
    key.active = true;
    key.note = note;
    key.down = true;
    this.closeContacts(key, 1);
    this.clickEnv += this.p.click * 0.05;
  }

  /** contacts close (or open) a few ms apart; a hard step is what makes the click */
  private closeContacts(k: OrganKey, target: number): void {
    const click = this.p.click;
    const spread = (0.4 + 2.4 * click) * 0.001 * this.sr;
    const ramp = (0.03 + 2.5 * (1 - click) * (1 - click)) * 0.001 * this.sr * (target ? 1 : 1.5);
    k.target = target;
    k.rate = 1 / Math.max(1, ramp);
    k.settled = false;
    const seed = k.note * 31 + (target ? 0 : 977) + ((this.percEnv * 1000) | 0);
    for (let d = 0; d < 9; d++) k.wait[d] = Math.floor(hash01(seed, d) * spread);
  }

  private release(k: OrganKey): void {
    k.down = false;
    this.closeContacts(k, 0);
    this.clickEnv += this.p.click * 0.02;
  }

  noteOff(id: number): void {
    for (const k of this.keys) {
      if (!k.active || !k.held.remove(id) || !k.held.empty) continue;
      if (!this.pedal) this.release(k);
    }
  }

  allNotesOff(): void {
    this.pedal = false;
    for (const k of this.keys) {
      if (!k.active) continue;
      k.held.clear();
      if (k.down) this.release(k);
    }
  }

  panic(): void {
    for (const k of this.keys) {
      k.active = false;
      k.down = false;
      k.held.clear();
      k.value.fill(0);
    }
    this.pedal = false;
    this.percEnv = 0;
    this.clickEnv = 0;
    this.scanner.clear();
    this.hornLine.clear();
    this.drumLine.clear();
  }

  activeVoices(): number {
    let n = 0;
    for (const k of this.keys) if (k.active) n++;
    return n;
  }

  private useWheel(w: number): void {
    if (!this.wheelUsed[w]) {
      this.wheelUsed[w] = 1;
      this.wheelConst[w] = 0;
      this.wheelDyn[w] = 0;
      this.usedList[this.usedCount++] = w;
    }
  }

  private dynBuf(w: number, n: number): Float64Array {
    const b = this.wheelBuf[w] as Float64Array;
    if (!this.wheelDyn[w]) {
      this.wheelDyn[w] = 1;
      b.fill(0, 0, n);
    }
    return b;
  }

  private stepRotor(r: Rotor, fast: boolean, n: number): number {
    const target = fast ? r.fast : r.slow;
    const tc = target > r.rate ? r.upTime : r.downTime;
    r.rate = target + (r.rate - target) * Math.exp(-n / (tc * this.sr));
    return r.rate / this.sr;
  }

  render(outL: Float32Array, outR: Float32Array, offset: number, count: number): void {
    const n = count;
    this.usedCount = 0;
    // percussion envelope for this block
    const perc = this.percBuf;
    const percOn = this.p.perc >= 0.5;
    let pe = this.percEnv;
    for (let i = 0; i < n; i++) {
      perc[i] = pe;
      pe *= this.percCoef;
    }
    this.percEnv = pe < 1e-5 ? 0 : pe;
    const percLevel = percOn ? this.p.percLevel * WHEEL_LEVEL * 1.4 : 0;
    const percOffset = this.p.percHarm >= 2.5 ? 19 : 12;

    for (const k of this.keys) {
      if (!k.active) continue;
      for (let d = 0; d < 9; d++) {
        const g = this.dbGain[d] as number;
        const w = wheelFor(k.note, d);
        const vNow = k.value[d] as number;
        const settledD = (k.wait[d] as number) <= 0 && vNow === k.target;
        if (settledD) {
          if (g > 0 && vNow > 0) {
            this.useWheel(w);
            this.wheelConst[w] = (this.wheelConst[w] as number) + g * vNow;
          }
          continue;
        }
        // contact in motion: per-sample gain
        this.useWheel(w);
        const buf = this.dynBuf(w, n);
        let v = vNow;
        let wait = k.wait[d] as number;
        for (let i = 0; i < n; i++) {
          if (wait > 0) wait--;
          else if (v < k.target) v = Math.min(k.target, v + k.rate);
          else if (v > k.target) v = Math.max(k.target, v - k.rate);
          buf[i] = (buf[i] as number) + g * v;
        }
        k.value[d] = v;
        k.wait[d] = wait;
      }
      // percussion on held keys through its harmonic's wheel
      if (percLevel > 0 && k.down && this.percEnv + (perc[0] as number) > 0) {
        let w = k.note + percOffset;
        while (w > WHEEL_HIGH) w -= 12;
        while (w < WHEEL_LOW) w += 12;
        this.useWheel(w);
        const buf = this.dynBuf(w, n);
        const c = k.value[2] as number; // rides on the 8′ contact
        for (let i = 0; i < n; i++) buf[i] = (buf[i] as number) + percLevel * (perc[i] as number) * c;
      }
      if (!k.down) {
        let done = true;
        for (let d = 0; d < 9; d++) if ((k.value[d] as number) > 0 || (k.wait[d] as number) > 0) done = false;
        if (done) {
          k.active = false;
          k.held.clear();
        }
      }
    }

    // tonewheels
    const mix = this.mix;
    mix.fill(0, 0, n);
    for (let u = 0; u < this.usedCount; u++) {
      const w = this.usedList[u] as number;
      this.wheelUsed[w] = 0;
      const inc = this.wheelInc[w] as number;
      let ph = this.wheelPhase[w] as number;
      const c = this.wheelConst[w] as number;
      if (this.wheelDyn[w]) {
        const buf = this.wheelBuf[w] as Float64Array;
        for (let i = 0; i < n; i++) {
          mix[i] = (mix[i] as number) + Math.sin(TWO_PI * ph) * (c + (buf[i] as number));
          ph += inc;
          if (ph >= 1) ph -= 1;
        }
      } else if (c !== 0) {
        for (let i = 0; i < n; i++) {
          mix[i] = (mix[i] as number) + Math.sin(TWO_PI * ph) * c;
          ph += inc;
          if (ph >= 1) ph -= 1;
        }
      }
      this.wheelPhase[w] = ph;
    }
    // keep unused wheels turning so phases stay free-running
    for (let w = WHEEL_LOW; w <= WHEEL_HIGH; w++) {
      if (this.wheelDyn[w] || this.wheelConst[w]) {
        this.wheelDyn[w] = 0;
        this.wheelConst[w] = 0;
        continue;
      }
      const ph = (this.wheelPhase[w] as number) + (this.wheelInc[w] as number) * n;
      this.wheelPhase[w] = ph - Math.floor(ph);
    }

    // post: click noise → scanner chorus → overdrive → rotary
    const fast = this.p.rotor >= 0.5;
    const hornInc = this.stepRotor(this.horn, fast, n);
    const drumInc = this.stepRotor(this.drum, fast, n);
    const sr = this.sr;
    const scanInc = 6.9 / sr;
    const hornDepth = 0.00038 * sr;
    const drumDepth = 0.00022 * sr;
    const hornBase = 0.0012 * sr;
    const drumBase = 0.0012 * sr;
    const reflDelay = 0.0011 * sr;
    for (let i = 0; i < n; i++) {
      let x = mix[i] as number;
      if (this.clickEnv > 1e-6) {
        const nz = this.noise.next();
        x += (nz - this.clickLp.process(nz)) * this.clickEnv;
        this.clickEnv *= this.clickDecay;
      }
      // chorus/vibrato scanner: modulated delay mixed with the dry signal
      const vib = this.vib.next();
      this.scanner.write(x);
      if (vib > 1e-4) {
        const s = Math.sin(TWO_PI * this.scanPhase);
        const wet = this.scanner.readCubic(2 + (0.0006 + 0.0005 * s) * sr * vib + 2);
        x = x * (1 - 0.5 * vib) + wet * 0.5 * vib;
      }
      this.scanPhase += scanInc;
      if (this.scanPhase >= 1) this.scanPhase -= 1;
      // preamp
      const d = this.drive.next();
      x = this.preLp.process(x);
      if (d > 1e-4) {
        const pre = 1.5 * (1 + 14 * d * d);
        const bias = 0.25 * d;
        const tb = fastTanh(bias);
        const sat = (fastTanh(x * pre + bias) - tb) / (Math.pow(pre, 0.8) * (1 - tb * tb));
        x += d * (sat - x);
      }
      // rotary speaker
      const lo = this.xover.process(x);
      const hi = this.hornLp.process(x - lo);
      this.hornLine.write(hi);
      this.drumLine.write(lo);
      const th = TWO_PI * this.horn.phase;
      const td = TWO_PI * this.drum.phase;
      // microphones at ±90°
      const hsL = Math.sin(th);
      const hcL = Math.cos(th);
      const dsL = Math.sin(td);
      const dcL = Math.cos(td);
      // horn: direct + cabinet reflection from the opposite side
      const hL = this.hornLine.readCubic(hornBase + hornDepth * hsL) * (1 - 0.32 * (1 - hcL)) + this.hornLine.readCubic(hornBase + reflDelay - hornDepth * hsL) * 0.3 * (1 - 0.32 * (1 + hcL));
      const hR = this.hornLine.readCubic(hornBase - hornDepth * hsL) * (1 - 0.32 * (1 + hcL)) + this.hornLine.readCubic(hornBase + reflDelay + hornDepth * hsL) * 0.3 * (1 - 0.32 * (1 - hcL));
      const dL = this.drumLine.readCubic(drumBase + drumDepth * dsL) * (1 - 0.18 * (1 - dcL));
      const dR = this.drumLine.readCubic(drumBase - drumDepth * dsL) * (1 - 0.18 * (1 + dcL));
      this.horn.phase += hornInc;
      if (this.horn.phase >= 1) this.horn.phase -= 1;
      this.drum.phase += drumInc;
      if (this.drum.phase >= 1) this.drum.phase -= 1;
      const m = this.rotorMix.next();
      const l = x * (1 - m) + (hL + dL) * m;
      const r = x * (1 - m) + (hR + dR) * m;
      const g = this.master.next();
      outL[offset + i] = (outL[offset + i] as number) + this.dcL.process(l) * g;
      outR[offset + i] = (outR[offset + i] as number) + this.dcR.process(r) * g;
    }
  }
}
