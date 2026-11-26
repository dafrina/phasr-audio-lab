/**
 * AudioEngine: owns the single AudioContext, the master bus, one TrackChannel
 * per track, the asset registry and the transport. It is independent of
 * React; the UI talks to it through `syncProject()` (driven by a store
 * subscription) and a few imperative calls (preview notes, meters, import).
 */
import { EffectChain } from './effectChain';
import { nextNoteInstanceId } from '../core/ids';
import { MASTER_ID, SEND_IDS, parsePadChainId, type Project, type Track } from '../project/types';
import { SendBusNode } from './sendBus';
import trioscWorkletUrl from './worklets/triosc.worklet.ts?worker&url';
import keysWorkletUrl from './worklets/keys.worklet.ts?worker&url';
import recorderWorkletUrl from './worklets/recorder.worklet.ts?worker&url';
import modsourceWorkletUrl from './worklets/modsource.worklet.ts?worker&url';
import { ModulationRouter } from './modulation';
import { DrumRackInstrument } from './drumRack';
import { AssetRegistry, type LoadedAsset } from './assets';
import { StereoMeter, type MeterReading } from './meter';
import { TrackChannel, dbToGainFader } from './trackChannel';
import { Transport } from './transport';
import { PeqUnit, isCompressorUnit } from './effects/units';
import { automatedInstKeys, valueAt } from '../project/automation';
import { chordToolActive, withChordsExpanded } from '../chords/expand';
import { LiveChords } from './chordLive';

export type LiveInputEvent =
  | { type: 'noteOn'; trackId: string; id: number; note: number; velocity: number; at: number }
  | { type: 'noteOff'; trackId: string; id: number; at: number }
  | { type: 'sustain'; trackId: string; on: boolean; at: number };

export type EngineStatus = 'idle' | 'loading' | 'ready' | 'error';

interface MasterBus {
  input: GainNode;
  /** master insert effects, before the fader */
  fx: EffectChain;
  gain: GainNode;
  limiter: DynamicsCompressorNode;
  out: GainNode;
  meter: StereoMeter;
  metronome: GainNode;
  limiterOn: boolean;
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  status: EngineStatus = 'idle';
  error: string | null = null;
  readonly assets = new AssetRegistry();
  transport: Transport | null = null;
  modulation: ModulationRouter | null = null;
  private master: MasterBus | null = null;
  /** send channels A and B (created with the master) */
  private sendBuses: SendBusNode[] = [];
  private readonly channels = new Map<string, TrackChannel>();
  private project: Project | null = null;
  private initPromise: Promise<void> | null = null;
  private readonly statusListeners = new Set<() => void>();
  /** called when the browser suspends/interrupts audio while playing */
  onInterrupted: ((reason: string) => void) | null = null;

  onStatus(fn: () => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  private setStatus(s: EngineStatus, error: string | null = null): void {
    this.status = s;
    this.error = error;
    for (const l of this.statusListeners) l();
  }

  init(): Promise<void> {
    this.initPromise ??= this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    this.setStatus('loading');
    try {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      await ctx.audioWorklet.addModule(trioscWorkletUrl);
      await ctx.audioWorklet.addModule(keysWorkletUrl);
      await ctx.audioWorklet.addModule(recorderWorkletUrl);
      await ctx.audioWorklet.addModule(modsourceWorkletUrl);
      this.ctx = ctx;
      this.master = buildMaster(ctx);
      this.transport = new Transport({
        ctx,
        // chord-tool tracks are scheduled with their chords expanded
        getProject: () => withChordsExpanded(this.requireProject()),
        channel: (id) => this.channels.get(id),
        audioBuffer: (id) => this.assets.get(id)?.buffer,
        metronomeOut: () => (this.master as MasterBus).metronome,
        modTrigger: (trackId, notes) => this.modulation?.trigger(trackId, notes),
        modCancel: (time) => this.modulation?.cancel(time),
      });
      this.modulation = new ModulationRouter(ctx, (id) => this.channels.get(id), true);
      // when stopped/paused/seeking, automated params jump to the curve value at the playhead
      this.transport.subscribe((snap) => {
        if (snap.state !== 'playing') this.applyAutomationAt(this.transport?.getTick() ?? 0);
      });
      ctx.addEventListener('statechange', () => {
        const st = ctx.state as string;
        if (st !== 'running' && this.transport?.isPlaying()) {
          this.transport.pause();
          this.onInterrupted?.(
            st === 'interrupted' ? 'Audio was interrupted by the system.' : 'Audio was suspended by the browser.',
          );
        }
        for (const l of this.statusListeners) l();
      });
      if (this.project) this.syncProject(this.project, true);
      this.setStatus('ready');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.setStatus('error', `Audio engine failed to start: ${msg}`);
      throw e;
    }
  }

  /** Must be called from a user gesture at least once (autoplay policy). */
  async resume(): Promise<void> {
    await this.init();
    if (this.ctx && this.ctx.state !== 'running') await this.ctx.resume();
  }

  isRunning(): boolean {
    return this.ctx?.state === 'running';
  }

  private requireProject(): Project {
    if (!this.project) throw new Error('No project loaded in engine');
    return this.project;
  }

  /**
   * Bring the audio graph in line with the project. Only what changed is
   * touched; the transport is rescheduled when timeline content changes.
   */
  syncProject(p: Project, force = false): void {
    const prev = this.project;
    this.project = p;
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;

    if (force || !prev || prev.master !== p.master) {
      master.gain.gain.setTargetAtTime(dbToGainFader(p.master.volumeDb), ctx.currentTime, 0.015);
      setLimiter(master, p.master.limiter);
    }
    // (tempo-synced master delays follow the BPM)
    if (force || !prev || prev.master !== p.master || prev.bpm !== p.bpm) master.fx.sync(p.master.effects ?? [], p.bpm);
    if (!this.sendBuses.length) this.sendBuses = SEND_IDS.map(() => new SendBusNode(ctx, master.input, true));
    const busesNew = force || !prev || prev.sends !== p.sends || prev.bpm !== p.bpm;
    if (busesNew) (p.sends ?? []).forEach((b, k) => this.sendBuses[k]?.update(b, p.bpm, !prev));
    const sendInputs = this.sendBuses.map((b) => b.input);

    const anySolo = p.tracks.some((t) => t.solo);
    const seen = new Set<string>();
    const prevTracks = new Map<string, Track>((prev?.tracks ?? []).map((t) => [t.id, t]));
    const prevAnySolo = prev ? prev.tracks.some((t) => t.solo) : false;
    for (const track of p.tracks) {
      seen.add(track.id);
      let ch = this.channels.get(track.id);
      const audible = !track.mute && (!anySolo || track.solo);
      if (!ch) {
        ch = new TrackChannel(ctx, track, master.input, true);
        this.channels.set(track.id, ch);
        ch.update(track, audible, true);
        ch.setSends(track.sends ?? [], sendInputs, true);
      } else if (force || prevTracks.get(track.id) !== track || prevAnySolo !== anySolo) {
        ch.update(track, audible);
        ch.setSends(track.sends ?? [], sendInputs);
      }
      ch.ensureInstrument(track.kind === 'instrument' ? track.instrument : null, (id) => this.assets.get(id)?.buffer, p.bpm);
      ch.instrument?.setTempo?.(p.bpm);
      if (force || !prevTracks.get(track.id) || prevTracks.get(track.id)?.automation !== track.automation || prevTracks.get(track.id)?.instrument?.type !== track.instrument?.type) {
        ch.instrument?.setAutomatedKeys(automatedInstKeys(track));
      }
      const prevTrack = prevTracks.get(track.id);
      if (force || !prevTrack || prevTrack.effects !== track.effects || prevTrack.automation !== track.automation || prev?.bpm !== p.bpm) {
        ch.syncEffects(track.effects, p.bpm, track);
      }
    }
    for (const [id, ch] of this.channels) {
      if (!seen.has(id)) {
        ch.dispose();
        this.channels.delete(id);
      }
    }

    // modulation routes depend on channels and effect units, so sync them last
    if (
      force ||
      !prev ||
      prev.tracks.length !== p.tracks.length ||
      prev.tracks.some((tr, i) => tr !== p.tracks[i] && (tr.modulations !== p.tracks[i]?.modulations || tr.effects !== p.tracks[i]?.effects || tr.id !== p.tracks[i]?.id))
    ) {
      this.modulation?.sync(p);
    }

    const t = this.transport;
    if (t && prev && !force) {
      const contentChanged =
        prev.clips !== p.clips ||
        prev.bpm !== p.bpm ||
        prev.loop !== p.loop ||
        prev.timeSignature !== p.timeSignature ||
        prev.metronome !== p.metronome ||
        prev.tracks.length !== p.tracks.length ||
        prev.tracks.some((tr, i) => tr.id !== p.tracks[i]?.id || tr.kind !== p.tracks[i]?.kind || tr.automation !== p.tracks[i]?.automation || tr.chords !== p.tracks[i]?.chords);
      if (contentChanged) t.reschedule();
      if (!t.isPlaying() && prev.tracks.some((tr, i) => tr.automation !== p.tracks[i]?.automation || tr.effects !== p.tracks[i]?.effects)) {
        this.applyAutomationAt(t.getTick());
      }
    }
  }

  /** Release every voice and stop every source immediately (project switch, panic). */
  panic(): void {
    this.transport?.stop();
    for (const ch of this.channels.values()) {
      ch.instrument?.panic();
      if (this.ctx) ch.stopSources(this.ctx.currentTime);
    }
  }

  // --- live note input (keyboard, piano roll preview) ---

  private readonly liveInputTaps = new Set<(e: LiveInputEvent) => void>();

  /** Observe live note input (Web MIDI, computer keys, on-screen keyboard) — used by MIDI recording. */
  onLiveInput(fn: (e: LiveInputEvent) => void): () => void {
    this.liveInputTaps.add(fn);
    return () => this.liveInputTaps.delete(fn);
  }

  private tap(e: LiveInputEvent): void {
    for (const fn of this.liveInputTaps) fn(e);
  }

  /** Gucci Slipper-izer: live chord playing / auto-play for chord-tool tracks */
  private readonly liveChords = new LiveChords({
    ctx: () => this.ctx,
    transport: () => this.transport,
    instrument: (id) => this.channels.get(id)?.instrument,
    project: () => this.project,
  });

  /** `at` = when the input happened (performance.now() ms; MIDI events carry their own timestamp). */
  previewNoteOn(trackId: string, note: number, velocity = 0.8, at = performance.now()): number | null {
    const inst = this.channels.get(trackId)?.instrument;
    if (!inst) return null;
    if (this.ctx && this.ctx.state !== 'running') void this.ctx.resume();
    const track = this.project?.tracks.find((t) => t.id === trackId);
    let id: number;
    if (chordToolActive(track)) {
      // one key → a whole chord (or the progression in auto-play); the virtual id releases it
      const vid = this.liveChords.noteOn(trackId, track.chords, note, velocity);
      if (vid === null) return null;
      id = vid;
    } else {
      id = nextNoteInstanceId();
      inst.noteOn(id, note, velocity);
    }
    this.modulation?.trigger(trackId, [{ time: -1, note }]); // live notes also fire MIDI sidechains
    this.tap({ type: 'noteOn', trackId, id, note, velocity, at });
    return id;
  }

  previewNoteOff(trackId: string, id: number, at = performance.now()): void {
    if (!this.liveChords.noteOff(id)) this.channels.get(trackId)?.instrument?.noteOff(id);
    this.tap({ type: 'noteOff', trackId, id, at });
  }

  sustain(trackId: string, on: boolean, at = performance.now()): void {
    this.channels.get(trackId)?.instrument?.sustain(on);
    this.tap({ type: 'sustain', trackId, on, at });
  }

  pitchBend(trackId: string, value: number): void {
    this.channels.get(trackId)?.instrument?.pitchBend(value);
  }

  allNotesOff(trackId?: string): void {
    this.liveChords.releaseAll(trackId);
    for (const [id, ch] of this.channels) if (!trackId || id === trackId) ch.instrument?.allNotesOff();
  }

  // --- metering ---

  readTrackMeter(trackId: string, out: MeterReading): MeterReading {
    const k = (SEND_IDS as readonly string[]).indexOf(trackId);
    if (k >= 0 && this.sendBuses[k]) return (this.sendBuses[k] as SendBusNode).meter.read(out);
    const ch = this.channels.get(trackId);
    if (!ch) {
      out.peakL = 0;
      out.peakR = 0;
      return out;
    }
    return ch.meter.read(out);
  }

  readMasterMeter(out: MeterReading): MeterReading {
    if (!this.master) {
      out.peakL = 0;
      out.peakR = 0;
      return out;
    }
    return this.master.meter.read(out);
  }

  // --- assets ---

  async importAudioFile(file: File): Promise<LoadedAsset> {
    await this.init();
    const ctx = this.ctx;
    if (!ctx) throw new Error('Audio engine is not available.');
    const bytes = await file.arrayBuffer();
    return this.assets.decodeBytes(ctx, bytes, file.name.replace(/\.[^.]+$/, ''), file.type || 'audio/*');
  }

  /** Set every automated parameter to its lane value at `tick` (used while not playing). */
  applyAutomationAt(tick: number): void {
    const ctx = this.ctx;
    const p = this.project;
    if (!ctx || !p) return;
    const now = ctx.currentTime;
    for (const track of p.tracks) {
      const ch = this.channels.get(track.id);
      if (!ch) continue;
      for (const lane of track.automation) {
        if (!lane.enabled) continue;
        const v = valueAt(lane.points, tick);
        if (v === null) continue;
        if (lane.target.kind === 'inst') {
          ch.instrument?.setAutomationValue(lane.target.param, v);
          continue;
        }
        for (const t of ch.automationParams(lane.target)) {
          t.param.cancelScheduledValues(now);
          t.param.setTargetAtTime(t.map(v), now, 0.01);
        }
      }
    }
  }

  /** Live drum rack instrument of a track (for pad hit flashes), if any. */
  drumRack(trackId: string): DrumRackInstrument | null {
    const inst = this.channels.get(trackId)?.instrument;
    return inst instanceof DrumRackInstrument ? inst : null;
  }

  /** Live Spectra EQ unit (for its curve and analyser), if present. */
  /** an effect unit on a track's chain, or on the master's (trackId = MASTER_ID) */
  private effectUnitOf(trackId: string, slotId: string) {
    if (trackId === MASTER_ID) return this.master?.fx.unit(slotId);
    const k = (SEND_IDS as readonly string[]).indexOf(trackId);
    if (k >= 0) return this.sendBuses[k]?.fx.unit(slotId);
    const pad = parsePadChainId(trackId);
    if (pad) {
      const inst = this.channels.get(pad.trackId)?.instrument;
      return inst instanceof DrumRackInstrument ? (inst.padEqUnit(pad.pad) ?? undefined) : undefined;
    }
    return this.channels.get(trackId)?.effectUnit(slotId);
  }

  peqUnit(trackId: string, slotId: string): PeqUnit | null {
    const u = this.effectUnitOf(trackId, slotId);
    return u instanceof PeqUnit ? u : null;
  }

  /** The node live input should be connected to for monitoring through a track. */
  channelInput(trackId: string): AudioNode | null {
    return this.channels.get(trackId)?.input ?? null;
  }

  /** Current gain reduction (dB, ≤ 0) of a compressor slot, for the UI. */
  compressorReduction(trackId: string, slotId: string): number {
    const u = this.effectUnitOf(trackId, slotId);
    return u && isCompressorUnit(u) ? u.reduction() : 0;
  }

  channelCount(): number {
    return this.channels.size;
  }
}

function buildMaster(ctx: AudioContext): MasterBus {
  const input = new GainNode(ctx);
  const fx = new EffectChain(ctx, true);
  const gain = new GainNode(ctx);
  // Safety limiter: a fast, hard-knee compressor just under 0 dBFS.
  const limiter = new DynamicsCompressorNode(ctx, { threshold: -1, knee: 0, ratio: 20, attack: 0.002, release: 0.12 });
  const out = new GainNode(ctx);
  const meter = new StereoMeter(ctx, true);
  const metronome = new GainNode(ctx, { gain: 0.8 });
  input.connect(fx.input);
  fx.output.connect(gain);
  gain.connect(limiter);
  limiter.connect(out);
  out.connect(ctx.destination);
  out.connect(meter.input);
  metronome.connect(ctx.destination); // metronome bypasses the master (and export)
  return { input, fx, gain, limiter, out, meter, metronome, limiterOn: true };
}

function setLimiter(m: MasterBus, on: boolean): void {
  if (m.limiterOn === on) return;
  m.gain.disconnect();
  if (on) m.gain.connect(m.limiter);
  else m.gain.connect(m.out);
  m.limiterOn = on;
}

export const engine = new AudioEngine();
