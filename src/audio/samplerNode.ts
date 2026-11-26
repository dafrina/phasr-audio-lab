/**
 * Sampler playback. Each note is an AudioBufferSourceNode started at its
 * exact scheduled time (sample-accurate, identical in an OfflineAudioContext)
 * with a pitch from its zone's root, a gain envelope (attack / release),
 * velocity scaling, sustain pedal and pitch bend.
 *
 * Buffers are resolved when a note starts, so samples that finish loading
 * after the project opened simply start working.
 */
import { dbToGain } from '../core/ids';
import type { InstrumentConfig } from '../project/types';
import type { SynthEvent } from '../synth/dsp/TriOscCore';
import { SAMPLER_BEND_SEMITONES as BEND_SEMITONES, mapZones, playbackRate, zoneFor, type MappedZone, type SamplerParams } from '../sampler/zones';
import { PITCH_BEND_KEY } from '../synth/dsp/bend';
import type { InstrumentNode } from './instruments';

type SamplerConfig = Extract<InstrumentConfig, { type: 'sampler' }>;


interface Voice {
  src: AudioBufferSourceNode;
  gain: GainNode;
  zone: MappedZone;
  note: number;
  /** playback rate without pitch bend (zone root, tune, transpose at the start) */
  baseRate: number;
  start: number;
  end: number;
  released: boolean;
}

type AutoSeg = { t0: number; v0: number; t1: number; v1: number };

export class SamplerInstrument implements InstrumentNode {
  readonly output: GainNode;
  private readonly ctx: BaseAudioContext;
  private config: SamplerConfig;
  private mapped: MappedZone[] = [];
  private readonly resolveAsset: (id: string) => AudioBuffer | undefined;
  private readonly voices = new Map<number, Voice>();
  private pedal = false;
  /** note ids whose key was released while the pedal was down */
  private readonly pedalHeld = new Set<number>();
  private bend = 0;
  private disposed = false;
  private readonly autoSegs = new Map<string, AutoSeg[]>();
  private readonly autoHeld = new Map<string, number>();
  private autoKeys = new Set<string>();

  constructor(ctx: BaseAudioContext, config: SamplerConfig, resolveAsset: (id: string) => AudioBuffer | undefined) {
    this.ctx = ctx;
    this.config = config;
    this.resolveAsset = resolveAsset;
    this.output = new GainNode(ctx);
    this.setConfig(config);
  }

  setConfig(config: SamplerConfig): void {
    this.config = config;
    this.mapped = mapZones(config);
  }

  private param<K extends keyof SamplerParams>(key: K, t: number): number {
    return this.autoAt(key, t, this.config.params[key]);
  }

  /** An automated value at time t (`base` when the key has no lane). */
  private autoAt(key: string, t: number, base: number): number {
    if (!this.autoKeys.has(key)) return base;
    let v = this.autoHeld.get(key) ?? base;
    for (const s of this.autoSegs.get(key) ?? []) {
      if (s.t0 > t) break;
      v = t >= s.t1 || s.t1 <= s.t0 ? s.v1 : s.v0 + ((s.v1 - s.v0) * (t - s.t0)) / (s.t1 - s.t0);
    }
    return v;
  }

  setAutomatedKeys(keys: string[]): void {
    const hadBend = this.autoKeys.has(PITCH_BEND_KEY);
    this.autoKeys = new Set(keys);
    for (const k of [...this.autoSegs.keys()]) if (!this.autoKeys.has(k)) this.autoSegs.delete(k);
    // a pitch-bend lane that goes away leaves the pitch centred
    if (hadBend && !this.autoKeys.has(PITCH_BEND_KEY)) {
      this.autoHeld.delete(PITCH_BEND_KEY);
      this.pitchBend(0);
    }
  }

  setAutomationValue(key: string, value: number): void {
    this.autoHeld.set(key, value);
    this.autoSegs.delete(key);
    if (key === PITCH_BEND_KEY) this.retune(this.ctx.currentTime, value);
  }

  /** Pitch bend (−1…+1) at time t: its automation lane when there is one, else the wheel. */
  private bendAt(t: number): number {
    return Math.max(-1, Math.min(1, this.autoAt(PITCH_BEND_KEY, t, this.bend)));
  }

  private bentRate(v: Voice, bend: number): number {
    return v.baseRate * Math.pow(2, (Math.max(-1, Math.min(1, bend)) * BEND_SEMITONES) / 12);
  }

  /** Glide every sounding voice to a bend value from time t. */
  private retune(t: number, bend: number): void {
    for (const v of this.voices.values()) {
      if (v.end <= t) continue;
      v.src.playbackRate.setTargetAtTime(this.bentRate(v, bend), Math.max(t, v.start), 0.005);
    }
  }

  /**
   * Put one pitch-bend automation segment on a voice's playback rate (the part
   * while it sounds). Semitones ramp linearly, so the rate ramps exponentially.
   */
  private bendVoice(v: Voice, s: AutoSeg): void {
    if (s.t1 <= v.start || s.t0 >= v.end) return;
    const p = v.src.playbackRate;
    if (s.t1 <= s.t0) {
      p.setValueAtTime(this.bentRate(v, s.v1), Math.max(s.t0, v.start));
      return;
    }
    const from = Math.max(s.t0, v.start);
    const v0 = s.v0 + ((s.v1 - s.v0) * (from - s.t0)) / (s.t1 - s.t0);
    p.setValueAtTime(this.bentRate(v, v0), from);
    p.exponentialRampToValueAtTime(this.bentRate(v, s.v1), s.t1);
  }

  private startNote(id: number, note: number, velocity: number, when: number): void {
    if (this.disposed) return;
    const ctx = this.ctx;
    const t = Math.max(when, ctx.currentTime);
    const transpose = Math.round(this.param('transpose', t));
    const vel127 = Math.max(1, Math.min(127, Math.round(velocity * 127)));
    const zone = zoneFor(this.mapped, note + transpose, vel127);
    if (!zone) return;
    const buf = this.resolveAsset(zone.assetId);
    if (!buf) return;
    // the same id restarting: end the previous voice first
    const prev = this.voices.get(id);
    if (prev) this.releaseVoice(prev, t, 0.01);
    const baseRate = playbackRate(zone, note, transpose);
    const rate = baseRate * Math.pow(2, (this.bendAt(t) * BEND_SEMITONES) / 12);
    const velSens = this.param('velSens', t);
    const level = dbToGain(zone.gain + this.param('gain', t)) * (1 - velSens + velSens * Math.pow(Math.max(0, Math.min(1, velocity)), 1.5));
    const attack = Math.max(0.001, this.param('attack', t));
    const src = new AudioBufferSourceNode(ctx, { buffer: buf, playbackRate: rate });
    const gain = new GainNode(ctx, { gain: 0 });
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(level, t + attack);
    src.connect(gain);
    gain.connect(this.output);
    // (the buffer may play slower when bent down: the voice lasts until it would end fully bent)
    const end = t + buf.duration / (baseRate * Math.pow(2, -BEND_SEMITONES / 12));
    src.start(t);
    src.stop(end + 0.01);
    const v: Voice = { src, gain, zone, note, baseRate, start: t, end, released: false };
    this.voices.set(id, v);
    // pitch-bend automation already scheduled for while it sounds
    if (this.autoKeys.has(PITCH_BEND_KEY)) for (const s of this.autoSegs.get(PITCH_BEND_KEY) ?? []) this.bendVoice(v, s);
    src.onended = () => {
      src.disconnect();
      gain.disconnect();
      if (this.voices.get(id) === v) this.voices.delete(id);
    };
  }

  private releaseVoice(v: Voice, when: number, releaseSec?: number): void {
    if (v.released) return;
    v.released = true;
    const t = Math.max(when, v.start, this.ctx.currentTime);
    const rel = releaseSec ?? Math.max(0.005, this.param('release', t));
    const g = v.gain.gain as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam };
    if (typeof g.cancelAndHoldAtTime === 'function') g.cancelAndHoldAtTime(t);
    else g.cancelScheduledValues(t);
    // exponential-ish release: −60 dB after `rel` seconds
    g.setTargetAtTime(0, t, rel / 6.9);
    const stopAt = Math.min(v.end, t + rel * 1.2) + 0.02;
    try {
      v.src.stop(stopAt);
    } catch {
      // already stopped
    }
    v.end = Math.min(v.end, stopAt);
  }

  private stopNote(id: number, when: number): void {
    const v = this.voices.get(id);
    if (!v || this.config.params.oneShot) return;
    if (this.pedal) {
      this.pedalHeld.add(id);
      return;
    }
    this.releaseVoice(v, when);
  }

  private setPedal(on: boolean, when: number): void {
    this.pedal = on;
    if (on) return;
    for (const id of this.pedalHeld) {
      const v = this.voices.get(id);
      if (v) this.releaseVoice(v, when);
    }
    this.pedalHeld.clear();
  }

  // ---- instrument interface ----

  schedule(events: SynthEvent[]): void {
    // automation first (a note reads its automated values when it starts), then in time order
    const sorted = [...events].sort((a, b) => (a.type === 'param' ? 0 : 1) - (b.type === 'param' ? 0 : 1) || a.time - b.time);
    for (const e of sorted) {
      switch (e.type) {
        case 'noteOn':
          this.startNote(e.id, e.note, e.velocity, e.time);
          break;
        case 'noteOff':
          this.stopNote(e.id, e.time);
          break;
        case 'sustain':
          this.setPedal(e.on, e.time);
          break;
        case 'bend':
          this.pitchBend(e.value, e.time);
          break;
        case 'allNotesOff':
          this.allNotesOff(e.time);
          break;
        case 'param': {
          const seg = { t0: e.time, v0: e.fromValue, t1: e.toTime, v1: e.toValue };
          const list = this.autoSegs.get(e.key) ?? [];
          list.push(seg);
          list.sort((a, b) => a.t0 - b.t0);
          this.autoSegs.set(e.key, list);
          // a bend moves the notes already sounding, too
          if (e.key === PITCH_BEND_KEY && this.autoKeys.has(PITCH_BEND_KEY)) for (const v of this.voices.values()) this.bendVoice(v, seg);
          break;
        }
      }
    }
  }

  noteOn(id: number, note: number, velocity: number, time = -1): void {
    this.startNote(id, note, velocity, time < 0 ? this.ctx.currentTime : time);
  }

  noteOff(id: number, time = -1): void {
    this.stopNote(id, time < 0 ? this.ctx.currentTime : time);
  }

  sustain(on: boolean, time = -1): void {
    this.setPedal(on, time < 0 ? this.ctx.currentTime : time);
  }

  pitchBend(value: number, time = -1): void {
    this.bend = Math.max(-1, Math.min(1, value));
    this.retune(time < 0 ? this.ctx.currentTime : time, this.bend);
  }

  /** Drop notes starting at/after `time`; release the ones already sounding there. */
  cancel(time: number): void {
    for (const [k, segs] of this.autoSegs) this.autoSegs.set(k, segs.filter((s) => s.t0 < time));
    for (const [id, v] of this.voices) {
      if (v.start >= time) {
        try {
          v.src.stop();
        } catch {
          // not started / already stopped
        }
        v.src.disconnect();
        v.gain.disconnect();
        this.voices.delete(id);
      } else {
        this.releaseVoice(v, time);
        // drop bend ramps scheduled past the cut (the released tail holds its pitch)
        const pr = v.src.playbackRate as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam };
        if (typeof pr.cancelAndHoldAtTime === 'function') pr.cancelAndHoldAtTime(Math.max(time, v.start));
      }
    }
    this.pedalHeld.clear();
    this.pedal = false;
  }

  allNotesOff(time = -1): void {
    const t = time < 0 ? this.ctx.currentTime : time;
    for (const v of this.voices.values()) this.releaseVoice(v, t);
    this.pedalHeld.clear();
  }

  panic(): void {
    const t = this.ctx.currentTime;
    for (const v of this.voices.values()) this.releaseVoice(v, t, 0.01);
    this.voices.clear();
    this.pedalHeld.clear();
    this.pedal = false;
  }

  activeVoices(): number {
    const now = this.ctx.currentTime;
    let n = 0;
    for (const v of this.voices.values()) if (v.end > now) n++;
    return n;
  }

  dispose(): void {
    if (this.disposed) return;
    this.panic();
    this.disposed = true;
    this.output.disconnect();
  }
}
