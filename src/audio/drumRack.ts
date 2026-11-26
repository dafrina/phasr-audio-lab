/**
 * Drum rack playback. Each hit is an AudioBufferSourceNode started at its
 * exact scheduled time (sample-accurate, and identical in an
 * OfflineAudioContext) → per-hit gain envelope → per-pad pan → output.
 *
 * Built-in pads are rendered once by the procedural drum synth and cached;
 * sample pads use decoded assets. Hits are one-shots (note-offs are ignored);
 * a pad's choke group cuts off other pads of the same group, like an open hat
 * silenced by the closed hat.
 *
 * Every pad has its own little bus: hits → pad input → (the pad's Spectra
 * EQ, if it has one) → rack output, plus two send taps feeding the track's
 * send channels (see TrackChannel).
 */
import { dbToGain } from '../core/ids';
import { DRUM_PADS, padIndexForNote } from '../drums/kit';
import { renderDrumVoice, voiceKey } from '../drums/synth';
import type { DrumKit, DrumPad } from '../project/types';
import { createEffectUnit, type EffectUnit } from './effects/units';
import { sendGain } from './sendGain';
import type { SynthEvent } from '../synth/dsp/TriOscCore';

interface Hit {
  src: AudioBufferSourceNode;
  gain: GainNode;
  pan: StereoPannerNode;
  pad: number;
  choke: number;
  start: number;
  end: number;
}

export class DrumRackInstrument {
  readonly output: GainNode;
  private readonly ctx: BaseAudioContext;
  private kit: DrumKit;
  private readonly resolveAsset: (id: string) => AudioBuffer | undefined;
  private buffers: (AudioBuffer | null)[] = [];
  private keys: string[] = [];
  private readonly hits = new Set<Hit>();
  /** context time of each pad's most recent scheduled hit (for UI flashes) */
  readonly lastHit = new Float64Array(DRUM_PADS).fill(-1);
  private disposed = false;
  private static synthCache = new Map<string, AudioBuffer>();
  /** automation segments per pad-param key ("p0.tune"), sorted by start time */
  private readonly autoSegs = new Map<string, { t0: number; v0: number; t1: number; v1: number }[]>();
  /** values set while stopped (live hits use these) */
  private readonly autoHeld = new Map<string, number>();
  private autoKeys = new Set<string>();
  /** per-pad bus: input → [EQ] → out → rack output (+ send taps) */
  private readonly padIn: GainNode[] = [];
  private readonly padOut: GainNode[] = [];
  private readonly padEq: (EffectUnit | null)[] = [];
  private readonly padSend: GainNode[][] = [];
  /** the rack's summed pad sends A / B (the track channel takes them to the send channels) */
  private readonly sendOuts: GainNode[];

  constructor(ctx: BaseAudioContext, kit: DrumKit, resolveAsset: (id: string) => AudioBuffer | undefined) {
    this.ctx = ctx;
    this.kit = kit;
    this.resolveAsset = resolveAsset;
    this.output = new GainNode(ctx);
    this.sendOuts = [new GainNode(ctx), new GainNode(ctx)];
    for (let i = 0; i < DRUM_PADS; i++) {
      const pin = new GainNode(ctx);
      const pout = new GainNode(ctx);
      pin.connect(pout);
      pout.connect(this.output);
      this.padIn.push(pin);
      this.padOut.push(pout);
      this.padEq.push(null);
      this.padSend.push([]);
    }
    this.setKit(kit);
  }

  /** Summed pad sends to send channels A and B. */
  sendOutputs(): AudioNode[] {
    return this.sendOuts;
  }

  /** The pad's EQ unit (for the device's curve and spectrum). */
  padEqUnit(i: number): EffectUnit | null {
    return this.padEq[i] ?? null;
  }

  private syncPadBus(i: number, p: DrumPad): void {
    const pin = this.padIn[i] as GainNode;
    const pout = this.padOut[i] as GainNode;
    const eq = p.eq ?? null;
    let unit = this.padEq[i] ?? null;
    if (eq && unit) unit.update(eq, 120);
    else if (eq && !unit) {
      unit = createEffectUnit(this.ctx, eq, 120);
      pin.disconnect();
      pin.connect(unit.input);
      unit.output.connect(pout);
      this.padEq[i] = unit;
    } else if (!eq && unit) {
      pin.disconnect();
      unit.dispose();
      pin.connect(pout);
      this.padEq[i] = null;
    }
    // send taps, created on first use
    const taps = this.padSend[i] as GainNode[];
    [0, 1].forEach((k) => {
      const g = sendGain(p.sends?.[k] ?? 0);
      let tap = taps[k];
      if (!tap) {
        if (g <= 0) return;
        tap = new GainNode(this.ctx, { gain: g });
        pout.connect(tap);
        tap.connect(this.sendOuts[k] as GainNode);
        taps[k] = tap;
        return;
      }
      tap.gain.setTargetAtTime(g, this.ctx.currentTime, 0.01);
    });
  }

  private bufferFor(p: DrumPad): { key: string; buf: AudioBuffer | null } {
    if (p.source.kind === 'sample') {
      return { key: `asset:${p.source.assetId}`, buf: this.resolveAsset(p.source.assetId) ?? null };
    }
    const key = voiceKey(p.source, this.ctx.sampleRate);
    // the synth cache is per sample rate (part of the key), shared across racks
    let buf = DrumRackInstrument.synthCache.get(key);
    if (!buf) {
      const data = renderDrumVoice(p.source, this.ctx.sampleRate);
      buf = new AudioBuffer({ length: data.length, numberOfChannels: 1, sampleRate: this.ctx.sampleRate });
      buf.copyToChannel(data, 0);
      if (DrumRackInstrument.synthCache.size > 256) DrumRackInstrument.synthCache.clear();
      DrumRackInstrument.synthCache.set(key, buf);
    }
    return { key, buf };
  }

  /** Apply a kit; only pads whose sound source changed are re-rendered. */
  setKit(kit: DrumKit): void {
    this.kit = kit;
    kit.pads.forEach((p, i) => {
      const { key, buf } = this.bufferFor(p);
      if (this.keys[i] !== key || (buf && this.buffers[i] !== buf)) {
        this.keys[i] = key;
        this.buffers[i] = buf;
      }
      this.syncPadBus(i, p);
    });
  }

  /** Re-resolve sample pads (e.g. after their asset finished loading). */
  refreshAssets(): void {
    this.keys = [];
    this.setKit(this.kit);
  }

  hasBuffer(i: number): boolean {
    return !!this.buffers[i];
  }

  /** Automated value of a pad parameter at time t (null = not automated). */
  private autoValue(key: string, t: number): number | null {
    if (!this.autoKeys.has(key)) return null;
    const segs = this.autoSegs.get(key);
    let v = this.autoHeld.get(key) ?? null;
    if (segs) {
      for (const s of segs) {
        if (s.t0 > t) break;
        v = t >= s.t1 || s.t1 <= s.t0 ? s.v1 : s.v0 + ((s.v1 - s.v0) * (t - s.t0)) / (s.t1 - s.t0);
      }
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

  /** Trigger pad `index` at `when` (context time; ≤ now plays immediately). */
  play(index: number, when: number, velocity: number): void {
    if (this.disposed) return;
    const base = this.kit.pads[index];
    // automation is sampled at the exact hit time
    const p = base
      ? {
          ...base,
          gain: this.autoValue(`p${index}.gain`, when) ?? base.gain,
          pan: this.autoValue(`p${index}.pan`, when) ?? base.pan,
          tune: this.autoValue(`p${index}.tune`, when) ?? base.tune,
          decay: this.autoValue(`p${index}.decay`, when) ?? base.decay,
        }
      : undefined;
    const buf = this.buffers[index];
    if (!p || !buf) return;
    const ctx = this.ctx;
    const t = Math.max(when, ctx.currentTime);
    // choke: fade out earlier hits of the same group that are still sounding at t
    if (p.choke > 0) {
      for (const h of this.hits) {
        if (h.choke === p.choke && h.start <= t && h.end > t) {
          h.gain.gain.cancelScheduledValues(t);
          h.gain.gain.setTargetAtTime(0, t, 0.004);
          try {
            h.src.stop(t + 0.03);
          } catch {
            // already stopped
          }
          h.end = t + 0.03;
        }
      }
    }
    const rate = Math.pow(2, p.tune / 12);
    const natural = buf.duration / rate;
    const level = dbToGain(p.gain) * (0.15 + 0.85 * Math.min(1, Math.max(0, velocity)) ** 1.3);
    const src = new AudioBufferSourceNode(ctx, { buffer: buf, playbackRate: rate });
    const gain = new GainNode(ctx, { gain: level });
    const pan = new StereoPannerNode(ctx, { pan: p.pan });
    src.connect(gain);
    gain.connect(pan);
    pan.connect(this.padIn[index] as GainNode);
    let end = t + natural;
    if (p.decay < natural) {
      // shorten the hit: hold, then a fast fade over the last 30 % of the decay time
      gain.gain.setValueAtTime(level, t + p.decay * 0.7);
      gain.gain.linearRampToValueAtTime(0, t + p.decay);
      end = t + p.decay;
    }
    src.start(t);
    src.stop(end + 0.01);
    const hit: Hit = { src, gain, pan, pad: index, choke: p.choke, start: t, end };
    this.hits.add(hit);
    this.lastHit[index] = t;
    src.onended = () => {
      src.disconnect();
      gain.disconnect();
      pan.disconnect();
      this.hits.delete(hit);
    };
  }

  // ---- instrument interface (shared with TriOscInstrument) ----

  schedule(events: SynthEvent[]): void {
    for (const e of events) {
      if (e.type === 'param') {
        const list = this.autoSegs.get(e.key) ?? [];
        list.push({ t0: e.time, v0: e.fromValue, t1: e.toTime, v1: e.toValue });
        list.sort((a, b) => a.t0 - b.t0);
        this.autoSegs.set(e.key, list);
        continue;
      }
      if (e.type !== 'noteOn') continue;
      const i = padIndexForNote(e.note);
      if (i >= 0) this.play(i, e.time, e.velocity);
    }
  }

  noteOn(_id: number, note: number, velocity: number, time = -1): void {
    const i = padIndexForNote(note);
    if (i >= 0) this.play(i, time < 0 ? this.ctx.currentTime : time, velocity);
  }

  noteOff(): void {
    // one-shots: hits always play out (shortened only by Decay / choke)
  }

  sustain(): void {}

  pitchBend(): void {}

  setPatch(): void {}

  /** Drop hits scheduled at/after `time`; hits already sounding ring out naturally. */
  cancel(time: number): void {
    for (const [k, segs] of this.autoSegs) this.autoSegs.set(k, segs.filter((s) => s.t0 < time));
    for (const h of this.hits) {
      if (h.start >= time) {
        try {
          h.src.stop();
        } catch {
          // not started / already stopped
        }
        h.src.disconnect();
        h.gain.disconnect();
        h.pan.disconnect();
        this.hits.delete(h);
      }
    }
  }

  allNotesOff(): void {}

  panic(): void {
    const t = this.ctx.currentTime;
    for (const h of this.hits) {
      h.gain.gain.cancelScheduledValues(t);
      h.gain.gain.setTargetAtTime(0, t, 0.003);
      try {
        h.src.stop(t + 0.02);
      } catch {
        // already stopped
      }
    }
  }

  activeHits(): number {
    return this.hits.size;
  }

  dispose(): void {
    if (this.disposed) return;
    this.panic();
    this.disposed = true;
    for (const u of this.padEq) u?.dispose();
    for (const n of [...this.padIn, ...this.padOut, ...this.padSend.flat(), ...this.sendOuts]) n.disconnect();
    this.output.disconnect();
  }
}
