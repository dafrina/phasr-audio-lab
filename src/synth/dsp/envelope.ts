/**
 * ADSR envelope generator.
 *
 * - Attack is a linear ramp toward 1 at a fixed rate (1 / attackTime per
 *   second). Retriggering starts the ramp from the *current* level, so a
 *   retrigger never jumps to zero (no click).
 * - Decay and release are exponential (one-pole) curves, which sound natural
 *   and are cheap. The coefficients are chosen so the stated time reaches
 *   about -60 dB (release) / within ~0.1% of sustain (decay).
 * - Changing parameters only recomputes coefficients; the current stage and
 *   level are kept, so tweaking knobs never restarts a sounding note.
 */
import type { EnvelopeParams } from '../params';

export const ENV_IDLE = 0;
export const ENV_ATTACK = 1;
export const ENV_DECAY = 2;
export const ENV_SUSTAIN = 3;
export const ENV_RELEASE = 4;
/** Very fast fade used for voice stealing / panic (~3 ms) */
export const ENV_KILL = 5;

const LN_1000 = Math.log(1000); // -60 dB
const SUSTAIN_SMOOTH_SEC = 0.005;
const KILL_SEC = 0.003;
const IDLE_THRESHOLD = 0.0005;

/** Shared, precomputed coefficients for one envelope parameter set. */
export class EnvelopeCoefs {
  attackInc = 1;
  decayCoef = 0;
  sustain = 1;
  releaseCoef = 0;
  sustainSmooth = 0;
  killDec = 1;

  set(p: EnvelopeParams, sampleRate: number): void {
    this.attackInc = 1 / Math.max(1, p.attack * sampleRate);
    this.decayCoef = Math.exp(-LN_1000 / Math.max(1, p.decay * sampleRate));
    this.sustain = p.sustain;
    this.releaseCoef = Math.exp(-LN_1000 / Math.max(1, p.release * sampleRate));
    this.sustainSmooth = Math.exp(-1 / Math.max(1, SUSTAIN_SMOOTH_SEC * sampleRate));
    this.killDec = 1 / Math.max(1, KILL_SEC * sampleRate);
  }
}

export class Envelope {
  stage = ENV_IDLE;
  value = 0;

  trigger(): void {
    this.stage = ENV_ATTACK;
  }

  release(): void {
    if (this.stage !== ENV_IDLE && this.stage !== ENV_KILL) this.stage = ENV_RELEASE;
  }

  kill(): void {
    if (this.stage !== ENV_IDLE) this.stage = ENV_KILL;
  }

  reset(): void {
    this.stage = ENV_IDLE;
    this.value = 0;
  }

  get active(): boolean {
    return this.stage !== ENV_IDLE;
  }

  /** Advance one sample and return the level. */
  next(c: EnvelopeCoefs): number {
    let v = this.value;
    switch (this.stage) {
      case ENV_ATTACK:
        v += c.attackInc;
        if (v >= 1) {
          v = 1;
          this.stage = ENV_DECAY;
        }
        break;
      case ENV_DECAY:
        v = c.sustain + (v - c.sustain) * c.decayCoef;
        if (Math.abs(v - c.sustain) < 1e-4) {
          v = c.sustain;
          this.stage = ENV_SUSTAIN;
        }
        break;
      case ENV_SUSTAIN:
        // follow sustain changes smoothly
        v = c.sustain + (v - c.sustain) * c.sustainSmooth;
        break;
      case ENV_RELEASE:
        v *= c.releaseCoef;
        if (v < IDLE_THRESHOLD) {
          v = 0;
          this.stage = ENV_IDLE;
        }
        break;
      case ENV_KILL:
        v -= c.killDec;
        if (v <= 0) {
          v = 0;
          this.stage = ENV_IDLE;
        }
        break;
      default:
        v = 0;
    }
    this.value = v;
    return v;
  }

  /** Advance n samples (used for control-rate envelopes) and return the final level. */
  advance(c: EnvelopeCoefs, n: number): number {
    let v = this.value;
    for (let i = 0; i < n; i++) v = this.next(c);
    return v;
  }
}

/** Compute the ADSR shape for UI drawing (normalized time per stage). */
export function envelopeShape(p: EnvelopeParams, holdSeconds = 0.5): { t: number; v: number }[] {
  const pts: { t: number; v: number }[] = [{ t: 0, v: 0 }];
  pts.push({ t: p.attack, v: 1 });
  const decaySteps = 24;
  for (let i = 1; i <= decaySteps; i++) {
    const t = (p.decay * i) / decaySteps;
    pts.push({ t: p.attack + t, v: p.sustain + (1 - p.sustain) * Math.exp((-LN_1000 * t) / p.decay) });
  }
  const relStart = p.attack + p.decay + holdSeconds;
  pts.push({ t: relStart, v: p.sustain });
  for (let i = 1; i <= decaySteps; i++) {
    const t = (p.release * i) / decaySteps;
    pts.push({ t: relStart + t, v: p.sustain * Math.exp((-LN_1000 * t) / p.release) });
  }
  return pts;
}
