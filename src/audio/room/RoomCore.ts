/**
 * Reverb Lite DSP (runs inside an AudioWorklet; pure and testable in Node).
 *
 * An algorithmic room instead of a convolution: each channel passes two
 * Schroeder all-pass diffusers (so a click becomes a dense wash, not a
 * flutter), then the 8-line feedback delay network Keyforge uses for its
 * rooms (Hadamard mixing, damping in the loop, slow delay modulation against
 * metallic ringing). The cost doesn't depend on the decay time, and decay,
 * tone and size are live parameters (no impulse response to rebuild), so
 * decay can be automated and sidechained.
 *
 * The node outputs only the reverb (wet) signal; the dry mix happens outside.
 * The level follows Reverb Pro's at the same decay (a longer decay gets
 * gently louder, like a bigger room), so the two can be swapped 1:1.
 * With silent input and a tail that has died away the network is skipped.
 */
import { DelayLine, FdnReverb } from '../../keys/dsp/common';

export interface RoomFrameParams {
  /** seconds to −60 dB */
  decay: number;
  /** extra decay seconds (sidechain), added to `decay` */
  decayShift: number;
  /** room size: scales the network's delay lengths (0.4 … 1.6) */
  size: number;
  /** damping cutoff in Hz: lower = darker tail */
  tone: number;
}

/** largest size the delay lines are allocated for */
export const ROOM_MAX_SIZE = 1.6;
const DIFF_G = 0.62;
/** all-pass lengths in ms, per channel (left / right differ for width) */
const DIFF_MS = [
  [4.77, 3.59],
  [5.31, 4.13],
];
/** below this the output counts as silent (≈ −120 dB) */
const SILENT = 1e-6;
const SLEEP_SEC = 0.25;

class Allpass {
  private readonly line: DelayLine;
  private readonly len: number;
  constructor(samples: number) {
    this.len = Math.max(1, samples);
    this.line = new DelayLine(this.len + 2);
  }
  process(x: number): number {
    const d = this.line.read(this.len);
    const v = x + DIFF_G * d;
    this.line.write(v);
    return d - DIFF_G * v;
  }
  clear(): void {
    this.line.clear();
  }
}

export class RoomCore {
  private readonly sr: number;
  private readonly fdn: FdnReverb;
  private readonly apL: Allpass[];
  private readonly apR: Allpass[];
  private decay = -1;
  private size = -1;
  private tone = -1;
  /** size moves towards its target a little per block (delay-length jumps would click) */
  private sizeNow = 1;
  private norm = 1;
  private quiet = 0;
  private asleep = true;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.fdn = new FdnReverb(sampleRate, ROOM_MAX_SIZE);
    this.fdn.setModulation(0.45, 0.4);
    this.apL = DIFF_MS.map(([l]) => new Allpass(Math.round(((l as number) / 1000) * sampleRate)));
    this.apR = DIFF_MS.map(([, r]) => new Allpass(Math.round(((r as number) / 1000) * sampleRate)));
  }

  /** Whether the network is idle (silent input, tail gone): nothing is computed. */
  get sleeping(): boolean {
    return this.asleep;
  }

  private configure(p: RoomFrameParams): void {
    const decay = Math.min(30, Math.max(0.1, p.decay + p.decayShift));
    const target = Math.min(ROOM_MAX_SIZE, Math.max(0.3, p.size));
    // glide size by at most 2 % per block
    const size = Math.abs(target - this.sizeNow) < 0.02 ? target : this.sizeNow + Math.sign(target - this.sizeNow) * 0.02;
    if (Math.abs(decay - this.decay) < 1e-4 && size === this.size && Math.abs(p.tone - this.tone) < 0.5) return;
    this.decay = decay;
    this.size = size;
    this.sizeNow = size;
    this.tone = p.tone;
    this.fdn.set(decay, size, Math.min(this.sr * 0.45, Math.max(200, p.tone)), 0);
    // the tail's energy grows with its length; scale it so the level follows Reverb Pro's
    // (measured: its wet level rises ~7.5 dB from 0.6 s to 6 s of decay), so the two swap 1:1
    this.norm = ((1.24 / Math.sqrt(0.35 + decay)) * Math.pow(decay / 2.2, 0.37));
  }

  /** Render one block of wet output. Returns false when the block was silent (asleep). */
  process(inL: Float32Array | null, inR: Float32Array | null, outL: Float32Array, outR: Float32Array, p: RoomFrameParams): boolean {
    const n = outL.length;
    let inPeak = 0;
    if (inL) for (let i = 0; i < n; i++) inPeak = Math.max(inPeak, Math.abs(inL[i] as number));
    if (inR) for (let i = 0; i < n; i++) inPeak = Math.max(inPeak, Math.abs(inR[i] as number));
    if (this.asleep && inPeak < SILENT) {
      outL.fill(0);
      outR.fill(0);
      return false;
    }
    if (this.asleep) {
      // waking up: start from a clean network
      this.fdn.clear();
      for (const a of [...this.apL, ...this.apR]) a.clear();
      this.asleep = false;
      this.quiet = 0;
    }
    this.configure(p);
    const fdn = this.fdn;
    const [aL0, aL1] = this.apL as [Allpass, Allpass];
    const [aR0, aR1] = this.apR as [Allpass, Allpass];
    const g = this.norm;
    let outPeak = 0;
    for (let i = 0; i < n; i++) {
      const xl = inL ? (inL[i] as number) : 0;
      const xr = inR ? (inR[i] as number) : xl;
      fdn.process(aL1.process(aL0.process(xl)), aR1.process(aR0.process(xr)));
      const l = fdn.outL * g;
      const r = fdn.outR * g;
      outL[i] = l;
      outR[i] = r;
      const a = Math.abs(l) + Math.abs(r);
      if (a > outPeak) outPeak = a;
    }
    // fall asleep once input and tail have both been silent for a moment
    if (inPeak < SILENT && outPeak < SILENT) {
      this.quiet += n;
      if (this.quiet > SLEEP_SEC * this.sr) this.asleep = true;
    } else this.quiet = 0;
    return true;
  }
}
