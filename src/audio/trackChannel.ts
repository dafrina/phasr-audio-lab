/**
 * Per-track audio graph:
 *
 *   [clip sources | TriOsc] → input → (insert FX) → volume → pan → mute/solo gate → meter → master
 *
 * Nodes are created once per track and updated in place, so changing a
 * track's settings never creates duplicate connections.
 */
import { dbToGain } from '../core/ids';
import type { AutomationTarget, EffectSlot, InstrumentConfig, Track } from '../project/types';
import { createInstrumentNode, updateInstrumentNode, type InstrumentNode } from './instruments';
import { automatedKeys, isTrackParamAutomated } from '../project/automation';
import { createEffectUnit, type EffectUnit, type ModInput, type ParamTarget } from './effects/units';
import { StereoMeter } from './meter';
import { sendGain } from './sendBus';

const PARAM_SMOOTH = 0.015;

interface ScheduledSource {
  src: AudioBufferSourceNode;
  gain: GainNode;
  stopTime: number;
}

export interface AudioPlayback {
  buffer: AudioBuffer;
  when: number;
  stopAt: number;
  sourcePos: number;
  gain: number;
  loop: { start: number; end: number } | null;
  fadeIn: number;
  fadeOut: number;
  /** clip-relative offset at which playback begins (0 = clip start) */
  clipOffset: number;
  /** total clip duration in seconds, to know where the clip's fade-out lies */
  clipDuration: number;
}

export class TrackChannel {
  readonly id: string;
  readonly input: GainNode;
  readonly volume: GainNode;
  readonly panner: StereoPannerNode;
  readonly gate: GainNode;
  readonly meter: StereoMeter;
  instrument: InstrumentNode | null = null;
  private readonly ctx: BaseAudioContext;
  private readonly sources = new Set<ScheduledSource>();
  /** Insert chain: input → units… → fxOut → duck → volume. fxOut is the sidechain tap. */
  private readonly fxOut: GainNode;
  /** Modulation (sidechain ducking) gain stage, after the tap so self-ducking can't loop */
  readonly duck: GainNode;
  private readonly units = new Map<string, EffectUnit>();
  private chainOrder: string[] = [];
  private wantedOrder: string[] = [];
  private rewireTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly realtime: boolean;
  /** post-fader send taps to the send channels (created on first use) */
  private readonly sendTaps: (GainNode | null)[] = [];

  constructor(ctx: BaseAudioContext, track: Track, destination: AudioNode, realtime: boolean) {
    this.ctx = ctx;
    this.id = track.id;
    this.input = new GainNode(ctx);
    this.volume = new GainNode(ctx, { gain: dbToGainFader(track.volumeDb) });
    this.panner = new StereoPannerNode(ctx, { pan: track.pan });
    this.gate = new GainNode(ctx, { gain: 1 });
    this.realtime = realtime;
    this.fxOut = new GainNode(ctx);
    this.duck = new GainNode(ctx, { gain: 1 });
    this.input.connect(this.fxOut);
    this.fxOut.connect(this.duck);
    this.duck.connect(this.volume);
    this.volume.connect(this.panner);
    this.panner.connect(this.gate);
    this.gate.connect(destination);
    this.meter = new StereoMeter(ctx, realtime);
    this.gate.connect(this.meter.input);
  }

  /** Sync fader/pan/instrument from track data (cheap; safe to call often). */
  update(track: Track, audible: boolean, immediate = false): void {
    const t = this.ctx.currentTime;
    const vol = dbToGainFader(track.volumeDb);
    const gate = audible ? 1 : 0;
    // automated parameters are driven by the transport, not by the static value
    const autoVol = isTrackParamAutomated(track, 'volumeDb');
    const autoPan = isTrackParamAutomated(track, 'pan');
    if (immediate) {
      if (!autoVol) this.volume.gain.value = vol;
      if (!autoPan) this.panner.pan.value = track.pan;
      this.gate.gain.value = gate;
    } else {
      if (!autoVol) this.volume.gain.setTargetAtTime(vol, t, PARAM_SMOOTH);
      if (!autoPan) this.panner.pan.setTargetAtTime(track.pan, t, PARAM_SMOOTH);
      this.gate.gain.setTargetAtTime(gate, t, PARAM_SMOOTH);
    }
  }

  /** Post-effects, pre-fader signal used as this track's sidechain source. */
  sidechainTap(): AudioNode {
    return this.fxOut;
  }

  /** AudioParams a modulation route adds its signal to. */
  modulationInputs(target: AutomationTarget): ModInput[] {
    if (target.kind === 'track') {
      return target.param === 'volumeDb'
        ? [{ param: this.duck.gain, scale: (d) => dbToGain(d) - 1 }] // gain = 1 + env·(10^(d/20) − 1)
        : [{ param: this.panner.pan, scale: (d) => d }];
    }
    // instrument parameters are driven through the instrument itself, not AudioParams
    if (target.kind === 'inst') return [];
    return this.units.get(target.slotId)?.modulationInputs(target.param) ?? [];
  }

  /** AudioParams driven by an automation lane target. */
  automationParams(target: AutomationTarget): ParamTarget[] {
    if (target.kind === 'track') {
      return target.param === 'volumeDb'
        ? [{ param: this.volume.gain, map: dbToGainFader }]
        : [{ param: this.panner.pan, map: (v) => Math.max(-1, Math.min(1, v)) }];
    }
    if (target.kind === 'inst') return [];
    return this.units.get(target.slotId)?.automationParams(target.param) ?? [];
  }

  private instrumentType: string | null = null;

  /**
   * Create, update or remove the track's instrument (any registered type).
   * Same-type changes are applied in place; a type change rebuilds the node.
   */
  ensureInstrument(config: InstrumentConfig | null, resolveAsset: (id: string) => AudioBuffer | undefined = () => undefined, bpm = 120): void {
    if (this.instrument && (!config || config.type !== this.instrumentType || !updateInstrumentNode(this.instrument, config))) {
      this.instrument.dispose();
      this.instrument = null;
      this.instrumentType = null;
    }
    if (!config || this.instrument) return;
    this.instrument = createInstrumentNode(this.ctx, config, { resolveAsset, bpm });
    this.instrumentType = config.type;
    this.instrument.output.connect(this.input);
  }

  /** Attach an already-created instrument (offline rendering passes events up front). */
  attachInstrument(inst: InstrumentNode, type: string): void {
    this.instrument?.dispose();
    this.instrument = inst;
    this.instrumentType = type;
    inst.output.connect(this.input);
  }

  /**
   * Bring the insert chain in line with the track's effect slots. Parameter
   * changes update units in place. Adding, removing or reordering slots
   * rewires the chain under a ~10 ms duck so the switch is click-free.
   */
  syncEffects(slots: EffectSlot[], bpm: number, track?: Track): void {
    for (const slot of slots) {
      const unit = this.units.get(slot.id);
      const auto = track ? automatedKeys(track, slot.id) : undefined;
      if (unit && unit.type === slot.type) unit.update(slot, bpm, auto);
      else {
        unit?.dispose();
        this.units.set(slot.id, createEffectUnit(this.ctx, slot, bpm, auto));
        this.chainOrder = this.chainOrder.filter((id) => id !== slot.id); // force rewire
      }
    }
    this.wantedOrder = slots.map((s) => s.id);
    const same = this.wantedOrder.length === this.chainOrder.length && this.wantedOrder.every((id, i) => id === this.chainOrder[i]);
    if (same) return;
    if (!this.realtime) {
      this.rewire();
      return;
    }
    if (this.rewireTimer) return; // a rewire is already pending; it will use the latest order
    const t = this.ctx.currentTime;
    this.fxOut.gain.setTargetAtTime(0, t, 0.002);
    this.rewireTimer = setTimeout(() => {
      this.rewireTimer = null;
      this.rewire();
      this.fxOut.gain.setTargetAtTime(1, this.ctx.currentTime, 0.003);
    }, 12);
  }

  private rewire(): void {
    this.input.disconnect();
    for (const u of this.units.values()) u.output.disconnect();
    let prev: AudioNode = this.input;
    for (const id of this.wantedOrder) {
      const u = this.units.get(id);
      if (!u) continue;
      prev.connect(u.input);
      prev = u.output;
    }
    prev.connect(this.fxOut);
    // release units that are no longer in the chain
    for (const [id, u] of this.units) {
      if (!this.wantedOrder.includes(id)) {
        u.dispose();
        this.units.delete(id);
      }
    }
    this.chainOrder = [...this.wantedOrder];
  }

  effectUnit(id: string): EffectUnit | undefined {
    return this.units.get(id);
  }

  playAudio(p: AudioPlayback): void {
    const ctx = this.ctx;
    const src = new AudioBufferSourceNode(ctx, { buffer: p.buffer });
    const g = new GainNode(ctx, { gain: 0 });
    src.connect(g);
    g.connect(this.input);
    const { when, stopAt } = p;
    if (stopAt <= when) return;
    // Fade in at the true clip start; a short de-click ramp when starting mid-clip.
    const fadeIn = p.clipOffset <= 1e-6 ? Math.max(0.002, p.fadeIn) : 0.004;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(p.gain, Math.min(stopAt, when + fadeIn));
    // Fade out toward the stop point (clip end, loop end or split).
    const fadeOut = Math.min(Math.max(0.002, p.fadeOut), (stopAt - when) / 2);
    g.gain.setValueAtTime(p.gain, Math.max(when + fadeIn, stopAt - fadeOut));
    g.gain.linearRampToValueAtTime(0, stopAt);
    if (p.loop) {
      src.loop = true;
      src.loopStart = p.loop.start;
      src.loopEnd = p.loop.end;
      src.start(when, p.sourcePos);
      src.stop(stopAt + 0.001);
    } else {
      if (p.sourcePos >= p.buffer.duration) return;
      src.start(when, p.sourcePos);
      src.stop(stopAt + 0.001);
    }
    const entry: ScheduledSource = { src, gain: g, stopTime: stopAt };
    this.sources.add(entry);
    src.onended = () => {
      src.disconnect();
      g.disconnect();
      this.sources.delete(entry);
    };
  }

  /** Stop all clip sources at `time` with a short fade (no clicks). */
  stopSources(time: number): void {
    for (const s of this.sources) {
      const g = s.gain.gain;
      g.cancelScheduledValues(time);
      g.setTargetAtTime(0, time, 0.004);
      try {
        s.src.stop(time + 0.03);
      } catch {
        // already stopped
      }
    }
  }

  activeSourceCount(): number {
    return this.sources.size;
  }

  /**
   * Send levels (0..1 each) to the send channels' inputs. Taken after fader, pan and mute/solo,
   * so a quieter or muted track sends less / nothing.
   */
  setSends(levels: readonly number[], inputs: readonly AudioNode[], immediate = false): void {
    inputs.forEach((dest, k) => {
      const g = sendGain(levels[k] ?? 0);
      let tap = this.sendTaps[k] ?? null;
      if (!tap) {
        if (g <= 0) return;
        tap = new GainNode(this.ctx, { gain: 0 });
        this.gate.connect(tap);
        tap.connect(dest);
        this.sendTaps[k] = tap;
      }
      if (immediate) tap.gain.value = g;
      else tap.gain.setTargetAtTime(g, this.ctx.currentTime, PARAM_SMOOTH);
    });
  }

  dispose(): void {
    for (const t of this.sendTaps) t?.disconnect();
    this.stopSources(this.ctx.currentTime);
    this.instrument?.dispose();
    this.instrument = null;
    this.input.disconnect();
    this.volume.disconnect();
    this.panner.disconnect();
    this.gate.disconnect();
    this.meter.dispose();
    if (this.rewireTimer) clearTimeout(this.rewireTimer);
    this.fxOut.disconnect();
    this.duck.disconnect();
    for (const u of this.units.values()) u.dispose();
    this.units.clear();
  }
}

/** Fader dB → gain, with the bottom of the range meaning silence. */
export function dbToGainFader(db: number): number {
  return db <= -59.9 ? 0 : dbToGain(db);
}
