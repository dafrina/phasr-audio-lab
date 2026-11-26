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
import { mapZones, playbackRate, zoneFor, type MappedZone, type SamplerParams } from '../sampler/zones';
import type { InstrumentNode } from './instruments';

type SamplerConfig = Extract<InstrumentConfig, { type: 'sampler' }>;

const BEND_SEMITONES = 2;

interface Voice {
  src: AudioBufferSourceNode;
  gain: GainNode;
  zone: MappedZone;
  note: number;
  start: number;
  end: number;
  released: boolean;
}

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
  private readonly autoSegs = new Map<string, { t0: number; v0: number; t1: number; v1: number }[]>();
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
    const base = this.config.params[key];
    if (!this.autoKeys.has(key)) return base;
    let v = this.autoHeld.get(key) ?? base;
    for (const s of this.autoSegs.get(key) ?? []) {
      if (s.t0 > t) break;
      v = t >= s.t1 || s.t1 <= s.t0 ? s.v1 : s.v0 + ((s.v1 - s.v0) * (t - s.t0)) / (s.t1 - s.t0);
    }
    return v;
  }

  setAutomatedKeys(keys: string[]): void {
    this.autoKeys = new Set(keys);
    for (const k of [...this.autoSegs.keys()]) if (!this.autoKeys.has(k)) this.autoSegs.delete(k);
  }

  setAutomationValue(key: string, value: number): void {
    this.autoHeld.set(key, value);
    this.autoSegs.delete(key);
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
    const rate = playbackRate(zone, note, transpose, this.bend * BEND_SEMITONES);
    const velSens = this.param('velSens', t);
    const level = dbToGain(zone.gain + this.param('gain', t)) * (1 - velSens + velSens * Math.pow(Math.max(0, Math.min(1, velocity)), 1.5));
    const attack = Math.max(0.001, this.param('attack', t));
    const src = new AudioBufferSourceNode(ctx, { buffer: buf, playbackRate: rate });
    const gain = new GainNode(ctx, { gain: 0 });
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(level, t + attack);
    src.connect(gain);
    gain.connect(this.output);
    const end = t + buf.duration / rate;
    src.start(t);
    src.stop(end + 0.01);
    const v: Voice = { src, gain, zone, note, start: t, end, released: false };
    this.voices.set(id, v);
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
    const sorted = [...events].sort((a, b) => a.time - b.time);
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
          const list = this.autoSegs.get(e.key) ?? [];
          list.push({ t0: e.time, v0: e.fromValue, t1: e.toTime, v1: e.toValue });
          list.sort((a, b) => a.t0 - b.t0);
          this.autoSegs.set(e.key, list);
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
    const t = time < 0 ? this.ctx.currentTime : time;
    const transpose = Math.round(this.config.params.transpose);
    for (const v of this.voices.values()) {
      if (v.end <= t) continue;
      v.src.playbackRate.setTargetAtTime(playbackRate(v.zone, v.note, transpose, this.bend * BEND_SEMITONES), Math.max(t, v.start), 0.005);
    }
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
      } else this.releaseVoice(v, time);
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
