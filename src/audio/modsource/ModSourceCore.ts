/**
 * Modulation source DSP (pure; runs in the AudioWorklet and in tests).
 * Produces a 0..1 control signal at audio rate:
 *
 *  audio mode — envelope follower: per-sample peak level of the sidechain
 *    input mapped from [threshold, threshold + RANGE_DB] onto 0..1, then
 *    smoothed with separate attack/release one-pole filters.
 *  midi mode — trigger envelope: each note-on (sample-accurate frame) ramps
 *    linearly to 1 over `attack` (starting from the current value, so fast
 *    retriggers never click), holds, then recovers with the same one-pole
 *    `release` time constant as the audio follower, so both modes feel alike.
 *
 * With `invert` the output is 1 − envelope.
 */
export type ModMode = 'audio' | 'midi';

export interface ModSettings {
  mode: ModMode;
  attack: number;
  release: number;
  threshold: number;
  hold: number;
  invert: boolean;
}

/** dB above threshold at which the follower is fully open */
export const RANGE_DB = 12;

const ST_IDLE = 0;
const ST_ATTACK = 1;
const ST_HOLD = 2;
const ST_RELEASE = 3;

export class ModSourceCore {
  private readonly sr: number;
  private s: ModSettings;
  private c = 0;
  private aCoef = 0;
  private rCoef = 0;
  private attackInc = 1;
  private holdFrames = 0;
  private relMul = 0;
  private stage = ST_IDLE;
  private holdLeft = 0;
  /** pending trigger frames, sorted; -1 = as soon as possible */
  private triggers: number[] = [];

  constructor(sampleRate: number, settings: ModSettings) {
    this.sr = sampleRate;
    this.s = settings;
    this.setSettings(settings);
  }

  setSettings(s: ModSettings): void {
    this.s = s;
    const sr = this.sr;
    this.aCoef = 1 - Math.exp(-1 / Math.max(1, s.attack * sr));
    this.rCoef = 1 - Math.exp(-1 / Math.max(1, s.release * sr));
    this.attackInc = 1 / Math.max(1, s.attack * sr);
    this.holdFrames = Math.round(s.hold * sr);
    // MIDI release: same time constant as the follower's release (≈37 % left after `release`)
    this.relMul = 1 - this.rCoef;
  }

  trigger(frame: number): void {
    const t = this.triggers;
    let i = t.length;
    while (i > 0 && (t[i - 1] as number) > frame) i--;
    t.splice(i, 0, frame);
  }

  /** Drop triggers at or after `frame` (transport rescheduled). */
  cancel(frame: number): void {
    this.triggers = this.triggers.filter((f) => f < frame);
  }

  value(): number {
    return this.s.invert ? 1 - this.c : this.c;
  }

  private fire(): void {
    this.stage = ST_ATTACK;
  }

  /**
   * Render one block of control signal into `out`. `inL/inR` are the sidechain
   * input (audio mode); `blockStartFrame` is the absolute frame of out[0].
   */
  process(blockStartFrame: number, inL: Float32Array | null, inR: Float32Array | null, out: Float32Array): void {
    const n = out.length;
    const s = this.s;
    let c = this.c;
    if (s.mode === 'audio') {
      const thr = s.threshold;
      const aC = this.aCoef;
      const rC = this.rCoef;
      for (let i = 0; i < n; i++) {
        const l = inL ? Math.abs(inL[i] as number) : 0;
        const r = inR ? Math.abs(inR[i] as number) : l;
        const x = l > r ? l : r;
        let target = 0;
        if (x > 1e-9) {
          target = (20 * Math.log10(x) - thr) / RANGE_DB;
          target = target < 0 ? 0 : target > 1 ? 1 : target;
        }
        c += (target - c) * (target > c ? aC : rC);
        out[i] = s.invert ? 1 - c : c;
      }
    } else {
      const trig = this.triggers;
      let ti = 0;
      for (let i = 0; i < n; i++) {
        const f = blockStartFrame + i;
        while (ti < trig.length && (trig[ti] as number) <= f) {
          this.fire();
          ti++;
        }
        switch (this.stage) {
          case ST_ATTACK:
            c += this.attackInc;
            if (c >= 1) {
              c = 1;
              this.stage = ST_HOLD;
              this.holdLeft = this.holdFrames;
            }
            break;
          case ST_HOLD:
            if (this.holdLeft-- <= 0) this.stage = ST_RELEASE;
            break;
          case ST_RELEASE:
            c *= this.relMul;
            if (c < 1e-4) {
              c = 0;
              this.stage = ST_IDLE;
            }
            break;
        }
        out[i] = s.invert ? 1 - c : c;
      }
      if (ti > 0) trig.splice(0, ti);
    }
    this.c = c;
  }
}
